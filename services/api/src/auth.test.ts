// The Google login flow end to end against a fake OpenID provider: real
// discovery, real PKCE, real RS256-signed ID tokens. Only Google is swapped out.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./test-helpers.js";

const CLIENT_ID = "labforge-test";
const CLIENT_SECRET = "test-secret";

interface PendingCode {
  challenge: string;
  nonce: string;
  claims: Record<string, unknown>;
}

describe("Google OIDC login (fake provider)", () => {
  let server: Server;
  let issuer: string;
  let signIdToken: (claims: Record<string, unknown>) => Promise<string>;
  const codes = new Map<string, PendingCode>();

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };

    server = createServer((req, res) => {
      const url = new URL(req.url!, issuer);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/.well-known/openid-configuration") {
          return res.end(
            JSON.stringify({
              issuer,
              authorization_endpoint: `${issuer}/authorize`,
              token_endpoint: `${issuer}/token`,
              jwks_uri: `${issuer}/jwks`,
              response_types_supported: ["code"],
              subject_types_supported: ["public"],
              id_token_signing_alg_values_supported: ["RS256"],
            }),
          );
        }
        if (url.pathname === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
        if (url.pathname === "/token" && req.method === "POST") {
          const form = new URLSearchParams(body);
          const pending = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? ""); // codes are single-use
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (!pending || challenge !== pending.challenge) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: "invalid_grant" }));
          }
          const idToken = await signIdToken({ nonce: pending.nonce, ...pending.claims });
          return res.end(JSON.stringify({ access_token: "at", token_type: "Bearer", expires_in: 3600, id_token: idToken }));
        }
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    signIdToken = (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(issuer)
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const configured = () =>
    setup({
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET: CLIENT_SECRET,
      APP_BASE_URL: "https://labs.example.test",
    });

  /** Run /auth/login, then play the provider: approve and mint a code. */
  async function startLogin(
    app: Awaited<ReturnType<typeof setup>>["app"],
    claims: Record<string, unknown>,
    returnTo = "/",
  ) {
    const login = await app.inject({ method: "GET", url: `/auth/login?returnTo=${encodeURIComponent(returnTo)}` });
    expect(login.statusCode).toBe(302);
    const authorize = new URL(login.headers.location as string);
    const oidcCookie = (login.headers["set-cookie"] as string).split(";")[0]!;
    const code = randomBytes(8).toString("hex");
    codes.set(code, {
      challenge: authorize.searchParams.get("code_challenge")!,
      nonce: authorize.searchParams.get("nonce")!,
      claims,
    });
    return { authorize, oidcCookie, code, state: authorize.searchParams.get("state")! };
  }

  it("sends the browser to the provider with PKCE (S256), state and nonce", async () => {
    const { app } = await configured();
    const { authorize } = await startLogin(app, {});
    expect(authorize.origin + authorize.pathname).toBe(`${issuer}/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      response_type: "code",
      scope: "openid email",
      redirect_uri: "https://labs.example.test/auth/callback",
      code_challenge_method: "S256",
    });
    for (const p of ["code_challenge", "state", "nonce"]) expect(authorize.searchParams.get(p)).toBeTruthy();
  });

  it("logs in: sets an HttpOnly, Secure, SameSite=Lax session cookie and redirects back", async () => {
    const { app } = await configured();
    const { oidcCookie, code, state } = await startLogin(
      app,
      { sub: "google-123", email: "alice@example.test", email_verified: true },
      "/somewhere",
    );
    const cb = await app.inject({
      method: "GET",
      url: `/auth/callback?code=${code}&state=${state}`,
      headers: { cookie: oidcCookie },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/somewhere");

    const setCookies = [cb.headers["set-cookie"]].flat() as string[];
    const session = setCookies.find((c) => c.startsWith("lf_session="))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Path=\//);

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: session.split(";")[0]! } });
    expect(me.json()).toEqual({ id: "google-123", email: "alice@example.test" });
  });

  it("rejects a callback whose state doesn't match (login CSRF)", async () => {
    const { app } = await configured();
    const { oidcCookie, code } = await startLogin(app, { sub: "x", email_verified: true });
    const cb = await app.inject({
      method: "GET",
      url: `/auth/callback?code=${code}&state=attacker-state`,
      headers: { cookie: oidcCookie },
    });
    expect(cb.statusCode).toBe(400);
    expect(cb.headers["set-cookie"]?.toString() ?? "").not.toContain("lf_session=");
  });

  it("rejects a callback without the login cookie (no flow was started here)", async () => {
    const { app } = await configured();
    const { code, state } = await startLogin(app, { sub: "x", email_verified: true });
    const cb = await app.inject({ method: "GET", url: `/auth/callback?code=${code}&state=${state}` });
    expect(cb.statusCode).toBe(400);
  });

  it("requires a verified email", async () => {
    const { app } = await configured();
    const { oidcCookie, code, state } = await startLogin(app, { sub: "x", email: "x@y.z", email_verified: false });
    const cb = await app.inject({
      method: "GET",
      url: `/auth/callback?code=${code}&state=${state}`,
      headers: { cookie: oidcCookie },
    });
    expect(cb.statusCode).toBe(403);
  });

  it.each(["//evil.example", "https://evil.example", "/\\evil.example"])(
    "never redirects off-site after login (returnTo=%s -> /)",
    async (target) => {
      const { app } = await configured();
      const { oidcCookie, code, state } = await startLogin(app, { sub: "y", email_verified: true }, target);
      const cb = await app.inject({
        method: "GET",
        url: `/auth/callback?code=${code}&state=${state}`,
        headers: { cookie: oidcCookie },
      });
      expect(cb.headers.location).toBe("/");
    },
  );
});
