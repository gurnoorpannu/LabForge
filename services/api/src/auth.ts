import { authVerifyDuration, LAB_ID_RE, type Config, type LabStore } from "@labforge/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as oidc from "openid-client";
import { z } from "zod";
import { SESSION_COOKIE, type SessionStore, type SessionUser } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionToken: string | null;
  }
  interface FastifyContextConfig {
    /** Skip the per-request session lookup (routes that do their own). */
    skipSession?: boolean;
  }
}

const OIDC_COOKIE = "lf_oidc";
const OIDC_COOKIE_MAX_AGE = 600; // the whole login round trip must finish within 10 min

// Only same-site relative paths: "/x" yes; "//evil.com" or "https://evil.com" no.
const returnTo = z
  .string()
  .regex(/^\/(?!\/)[\w\-./?=&%#]*$/)
  .catch("/");

const oidcState = z.object({
  verifier: z.string(),
  state: z.string(),
  nonce: z.string(),
  returnTo: z.string(),
});

export async function registerAuth(
  app: FastifyInstance,
  { config, sessions, store }: { config: Config; sessions: SessionStore; store: LabStore },
) {
  const cookieBase = {
    httpOnly: true,
    sameSite: "lax" as const, // sent on top-level navigations (OIDC redirect back), not on cross-site POSTs
    secure: config.session.secureCookie,
    signed: true,
  };

  /** Verified raw token from the signed session cookie, or null. */
  const tokenFrom = (req: FastifyRequest): string | null => {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = req.unsignCookie(raw);
    return unsigned.valid ? unsigned.value : null;
  };

  app.decorateRequest("user", null);
  app.decorateRequest("sessionToken", null);

  // Who is calling. Never rejects; routes that need a user use requireUser.
  // Runs before the per-route rate limiter, so limits are keyed per user.
  app.addHook("onRequest", async (req) => {
    if (req.routeOptions.config.skipSession) return;
    const token = tokenFrom(req);
    if (!token) return;
    req.user = await sessions.resolve(token);
    if (req.user) req.sessionToken = token;
  });

  // --- ForwardAuth ----------------------------------------------------------

  // Traefik calls this before every request to /lab/<id>/... including the
  // websocket upgrade. The lab id comes from the lab's own Middleware address
  // (?lab=), never from the client-controlled path.
  app.route({
    method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/auth/verify",
    config: { skipSession: true },
    handler: async (req, reply) => {
      const timer = authVerifyDuration.startTimer();
      reply.header("cache-control", "no-store");
      const labId = (req.query as Record<string, unknown>).lab;
      const token = tokenFrom(req);
      if (typeof labId !== "string" || !LAB_ID_RE.test(labId) || !token) {
        timer({ result: "unauthenticated" });
        return reply.code(401).send("login required\n");
      }
      const { userId, owns } = await sessions.checkLabAccess(token, labId);
      if (!userId) {
        timer({ result: "unauthenticated" });
        return reply.code(401).send("login required\n");
      }
      if (!owns) {
        timer({ result: "forbidden" });
        return reply.code(403).send("not your lab\n");
      }
      timer({ result: "allowed" });
      return reply.code(200).send();
    },
  });

  // --- Google OIDC (authorization code + PKCE) --------------------------------

  let discovered: Promise<oidc.Configuration> | undefined;
  const oidcConfig = () => {
    const { issuer, clientId, clientSecret } = config.oidc;
    // Lazy, so the API starts and serves labs even if the issuer is unreachable.
    discovered ??= oidc
      .discovery(new URL(issuer), clientId!, clientSecret, undefined, {
        // Only for a local/test issuer on http://. Google is https.
        execute: issuer.startsWith("http://") ? [oidc.allowInsecureRequests] : [],
      })
      .catch((err: unknown) => {
        discovered = undefined; // retry on the next login instead of caching the failure
        throw err;
      });
    return discovered;
  };

  app.get("/auth/login", async (req, reply) => {
    if (!config.oidc.clientId || !config.oidc.clientSecret) {
      return reply.code(503).send({ error: "login_not_configured" });
    }
    const cfg = await oidcConfig();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const target = returnTo.parse((req.query as Record<string, unknown>).returnTo);

    reply.setCookie(OIDC_COOKIE, JSON.stringify({ verifier, state, nonce, returnTo: target }), {
      ...cookieBase,
      path: "/auth",
      maxAge: OIDC_COOKIE_MAX_AGE,
    });
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: config.oidc.redirectUri,
      scope: "openid email",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return reply.redirect(url.href);
  });

  app.get("/auth/callback", async (req, reply) => {
    const raw = req.cookies[OIDC_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    const pending = unsigned?.valid ? oidcState.safeParse(parseJson(unsigned.value!)) : null;
    reply.clearCookie(OIDC_COOKIE, { path: "/auth" });
    if (!pending?.success) return reply.code(400).send({ error: "login_expired_try_again" });

    try {
      const cfg = await oidcConfig();
      const tokens = await oidc.authorizationCodeGrant(
        cfg,
        new URL(req.url, config.appBaseUrl),
        {
          pkceCodeVerifier: pending.data.verifier,
          expectedState: pending.data.state,
          expectedNonce: pending.data.nonce,
          idTokenExpected: true,
        },
      );
      const claims = tokens.claims();
      if (!claims?.sub || claims.email_verified !== true) {
        return reply.code(403).send({ error: "verified_email_required" });
      }
      const email = typeof claims.email === "string" ? claims.email : null;
      await store.upsertUser(claims.sub, email);
      const token = await sessions.create(claims.sub, config.session.ttlSeconds);
      await store.audit(claims.sub, "auth.login", null);

      reply.setCookie(SESSION_COOKIE, token, {
        ...cookieBase,
        path: "/",
        maxAge: config.session.ttlSeconds,
      });
      return reply.redirect(pending.data.returnTo);
    } catch (err) {
      req.log.warn({ err }, "OIDC callback rejected");
      return reply.code(400).send({ error: "login_failed" });
    }
  });

  app.post("/auth/logout", async (req, reply) => {
    if (req.sessionToken) await sessions.destroy(req.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/me", { preHandler: requireUser }, async (req) => req.user);
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
}
