// Real k3d + Traefik + Postgres. Skipped unless INTEGRATION=1.
//
//   make dev-up && make lab-image lab-image-import && make dev-db
//   make test-integration
//
// The API listens on the Mac (:3000); Traefik reaches /auth/verify through
// host.k3d.internal. Every request below goes through the real Traefik on :8080.
import {
  createK8s,
  createLabStore,
  createPool,
  loadConfig,
  migrate,
  type K8s,
} from "@labforge/shared";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../services/api/src/server.js";
import { createSessionStore, sessionCookieHeader } from "../../services/api/src/sessions.js";

const enabled = process.env.INTEGRATION === "1";

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Raw HTTP GET; the path is sent byte-for-byte (fetch would normalise "../"). */
function get(base: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });
}

/** Websocket handshake the way ttyd's page does it. 101 = upgraded. */
function wsHandshake(base: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Protocol": "tty",
        ...headers,
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(!enabled)("lab access through Traefik ForwardAuth (k3d)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let pool: pg.Pool;
  let k8s: K8s;
  let config: ReturnType<typeof loadConfig>;
  let sessions: ReturnType<typeof createSessionStore>;
  const run = `it-${Date.now()}`;
  const as: Record<"alice" | "bob", { cookie: string }> = {} as never;
  const labs: Record<"alice" | "bob", { labId: string; url: string }> = {} as never;
  const path = (who: "alice" | "bob", rest = "") => `/lab/${labs[who].labId}/${rest}`;

  beforeAll(async () => {
    config = loadConfig({
      DATABASE_URL: "postgres://labforge:labforge@localhost:5432/labforge",
      NODE_CIDR: "172.28.0.0/16",
      SESSION_SECRET: "integration-test-secret-0123456789abcdef",
      ...process.env,
      NODE_ENV: "test",
    });
    pool = createPool(config.databaseUrl);
    await migrate(pool);
    k8s = createK8s();
    const store = createLabStore(pool);
    sessions = createSessionStore(pool);
    app = await buildServer({ config, store, sessions, k8s, logger: false });
    // Traefik calls back into this process for every lab request.
    await app.listen({ host: "0.0.0.0", port: Number(new URL(config.authVerifyUrl).port) });

    for (const who of ["alice", "bob"] as const) {
      const id = `${run}-${who}`;
      await store.upsertUser(id, `${who}@example.test`);
      as[who] = { cookie: sessionCookieHeader(await sessions.create(id, 3600), config.session.secret) };
    }
  });

  afterAll(async () => {
    for (const who of ["alice", "bob"] as const) {
      if (as[who]) await app?.inject({ method: "DELETE", url: "/api/labs/me", headers: as[who] });
    }
    await app?.close();
    await pool?.end();
  });

  it("starts a lab for each user; the owner's terminal comes up through Traefik", async () => {
    for (const who of ["alice", "bob"] as const) {
      const res = await app.inject({ method: "POST", url: "/api/labs", headers: as[who] });
      expect(res.statusCode).toBe(201);
      expect(res.json().ready).toBe(true);
      labs[who] = res.json();
    }
    // Traefik needs a moment to load each new Ingress + Middleware and its endpoints
    // (503 until the endpoints land).
    for (const who of ["alice", "bob"] as const) {
      const up = await waitFor(async () => (await get(config.publicBaseUrl, path(who), as[who])) === 200, 30_000);
      expect(up, `${who}'s terminal reachable`).toBe(true);
    }
  }, 180_000);

  it("401 without a session, 401 with a forged cookie, 403 for another user", async () => {
    expect(await get(config.publicBaseUrl, path("alice"))).toBe(401);
    const forged = as.alice.cookie.slice(0, -2) + (as.alice.cookie.endsWith("A") ? "BB" : "AA");
    expect(await get(config.publicBaseUrl, path("alice"), { cookie: forged })).toBe(401);
    expect(await get(config.publicBaseUrl, path("alice"), as.bob)).toBe(403);
    expect(await get(config.publicBaseUrl, path("bob"), as.bob)).toBe(200);
  });

  it("guards the websocket the terminal runs over: 101 owner, 401 anonymous, 403 other user", async () => {
    expect(await wsHandshake(config.publicBaseUrl, path("alice", "ws"), as.alice)).toBe(101);
    expect(await wsHandshake(config.publicBaseUrl, path("alice", "ws"))).toBe(401);
    expect(await wsHandshake(config.publicBaseUrl, path("alice", "ws"), as.bob)).toBe(403);
  });

  it("can't be fooled by a spoofed X-Forwarded-Uri pointing at the caller's own lab", async () => {
    const spoof = { ...as.bob, "X-Forwarded-Uri": path("bob"), "X-Forwarded-Prefix": `/lab/${labs.bob.labId}` };
    expect(await get(config.publicBaseUrl, path("alice"), spoof)).toBe(403);
  });

  it.each([
    ["dot segments", (b: string, a: string) => `/lab/${b}/../${a}/`],
    ["encoded dot segments", (b: string, a: string) => `/lab/${b}/%2e%2e/${a}/`],
    ["encoded slash", (b: string, a: string) => `/lab/${b}%2f..%2f${a}/`],
  ])("can't reach another lab with path tricks (%s)", async (_name, trick) => {
    const status = await get(config.publicBaseUrl, trick(labs.bob.labId, labs.alice.labId), as.bob);
    expect(status).not.toBe(200);
    expect(status).not.toBe(101);
  });

  it("denies the owner once the lab has expired (before the reaper deletes it)", async () => {
    await pool.query("UPDATE labs SET expires_at = now() - interval '1 second' WHERE id = $1", [labs.bob.labId]);
    expect(await get(config.publicBaseUrl, path("bob"), as.bob)).toBe(403);
  });

  it("denies a logged-out session (other sessions of the same user keep working)", async () => {
    const second = {
      cookie: sessionCookieHeader(await sessions.create(`${run}-alice`, 3600), config.session.secret),
    };
    expect(await get(config.publicBaseUrl, path("alice"), second)).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/logout", headers: second })).statusCode).toBe(204);
    expect(await get(config.publicBaseUrl, path("alice"), second)).toBe(401);
    expect(await get(config.publicBaseUrl, path("alice"), as.alice)).toBe(200);
  });

  it("ending a lab cuts access at once and removes its namespace", async () => {
    expect((await app.inject({ method: "DELETE", url: "/api/labs/me", headers: as.alice })).statusCode).toBe(204);
    // The DB row is marked deleted first, so verify denies even while the namespace terminates.
    expect([403, 404, 502, 503]).toContain(await get(config.publicBaseUrl, path("alice"), as.alice));
    expect(await waitFor(async () => !(await k8s.namespaceExists(labs.alice.labId)), 120_000)).toBe(true);
  }, 150_000);
});
