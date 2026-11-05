import { describe, expect, it } from "vitest";
import { registry } from "@labforge/shared";
import { setup } from "./test-helpers.js";

describe("lab API", () => {
  it("rejects anonymous callers", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/labs" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/labs/me" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
  });

  it("no longer trusts the Phase 2 dev header", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "POST", url: "/api/labs", headers: { "x-dev-user": "alice" } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a session cookie with a forged signature", async () => {
    const { app, as } = await setup();
    const { cookie } = await as("alice");
    const forged = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: forged } })).statusCode).toBe(401);
  });

  it("cold-starts a lab and returns its URL", async () => {
    const { app, k8s, as } = await setup();
    const res = await app.inject({ method: "POST", url: "/api/labs", headers: await as("alice") });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.labId).toMatch(/^[a-z2-7]{16}$/);
    expect(body).toMatchObject({
      url: `https://labs.example.test/lab/${body.labId}/`,
      startedFrom: "cold",
      ready: true,
    });
    const kinds = k8s.applyLab.mock.calls[0]![0].map((o: { kind: string }) => o.kind);
    expect(kinds).toEqual(expect.arrayContaining(["Middleware", "Ingress"]));
  });

  it("allows one active lab per user (409 with the existing lab)", async () => {
    const { app, as } = await setup();
    const headers = await as("alice");
    const first = (await app.inject({ method: "POST", url: "/api/labs", headers })).json();
    const second = await app.inject({ method: "POST", url: "/api/labs", headers });
    expect(second.statusCode).toBe(409);
    expect(second.json().lab.labId).toBe(first.labId);
  });

  it("returns 503 + Retry-After when the cluster is at capacity", async () => {
    const { app, as } = await setup({ MAX_CONCURRENT_LABS: "1" });
    await app.inject({ method: "POST", url: "/api/labs", headers: await as("alice") });
    const res = await app.inject({ method: "POST", url: "/api/labs", headers: await as("bob") });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.json().error).toBe("at_capacity");
  });

  it("rolls back the namespace and the DB row when Kubernetes fails", async () => {
    const { app, k8s, as } = await setup();
    const headers = await as("alice");
    k8s.applyLab.mockRejectedValueOnce(new Error("boom"));
    const res = await app.inject({ method: "POST", url: "/api/labs", headers });
    expect(res.statusCode).toBe(500);
    expect(k8s.deleteLab).toHaveBeenCalledOnce();
    // The failed lab doesn't block a retry.
    expect((await app.inject({ method: "GET", url: "/api/labs/me", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/labs", headers })).statusCode).toBe(201);
  });

  it("gets and ends the current lab", async () => {
    const { app, k8s, as } = await setup();
    const headers = await as("alice");
    expect((await app.inject({ method: "GET", url: "/api/labs/me", headers })).statusCode).toBe(404);
    const { labId } = (await app.inject({ method: "POST", url: "/api/labs", headers })).json();

    const me = await app.inject({ method: "GET", url: "/api/labs/me", headers });
    expect(me.json().labId).toBe(labId);

    const del = await app.inject({ method: "DELETE", url: "/api/labs/me", headers });
    expect(del.statusCode).toBe(204);
    expect(k8s.deleteLab).toHaveBeenCalledWith(labId);
    expect((await app.inject({ method: "GET", url: "/api/labs/me", headers })).statusCode).toBe(404);
  });

  it("rate-limits lab starts per user", async () => {
    const { app, as } = await setup({ RATE_LIMIT_PER_MIN: "2" });
    const alice = await as("alice");
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await app.inject({ method: "POST", url: "/api/labs", headers: alice })).statusCode);
    }
    expect(codes).toEqual([201, 409, 429]);
    // A different user has their own budget.
    expect((await app.inject({ method: "POST", url: "/api/labs", headers: await as("bob") })).statusCode).toBe(201);
  });
});

describe("warm pool", () => {
  it("claims a warm lab: hands over the running pod and only adds its route", async () => {
    const { app, k8s, as, backend } = await setup();
    backend.addWarmLab("warmlab000000001");
    const res = await app.inject({ method: "POST", url: "/api/labs", headers: await as("alice") });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ labId: "warmlab000000001", startedFrom: "warm", ready: true });
    expect(k8s.markClaimed).toHaveBeenCalledWith("warmlab000000001", "alice", expect.any(Number));
    const kinds = k8s.applyLab.mock.calls[0]![0].map((o: { kind: string }) => o.kind);
    expect(kinds).toEqual(["Middleware", "Ingress"]); // no new namespace, pod, ...
  });

  it("falls back to a cold start once the pool is empty, oldest warm lab first", async () => {
    const { app, as, backend } = await setup();
    backend.addWarmLab("warmlab00000000a");
    backend.addWarmLab("warmlab00000000b");
    const ids = [];
    for (const u of ["u1", "u2", "u3"]) {
      ids.push((await app.inject({ method: "POST", url: "/api/labs", headers: await as(u) })).json());
    }
    expect(ids.map((l) => l.startedFrom)).toEqual(["warm", "warm", "cold"]);
    expect(ids[0].labId).toBe("warmlab00000000a");
  });

  it("rolls a failed warm claim back like a cold one", async () => {
    const { app, k8s, as, backend } = await setup();
    backend.addWarmLab("warmlab000000001");
    k8s.markClaimed.mockRejectedValueOnce(new Error("boom"));
    const headers = await as("alice");
    expect((await app.inject({ method: "POST", url: "/api/labs", headers })).statusCode).toBe(500);
    expect(k8s.deleteLab).toHaveBeenCalledWith("warmlab000000001");
    expect((await app.inject({ method: "GET", url: "/api/labs/me", headers })).statusCode).toBe(404);
  });

  it("exposes pool and active-lab gauges from the database", async () => {
    const { app, as, backend } = await setup();
    backend.addWarmLab("warmlab000000001");
    backend.addWarmLab("warmlab000000002");
    await app.inject({ method: "POST", url: "/api/labs", headers: await as("alice") });
    await backend.store.heartbeat("reaper", 3);
    const body = await registry.metrics();
    expect(body).toMatch(/^labforge_labs_active 1$/m);
    expect(body).toMatch(/^labforge_pool_ready\{state="ready"\} 1$/m);
    expect(body).toMatch(/^labforge_labs_reaped_total 3$/m);
    expect(body).toMatch(/^labforge_reaper_last_success_timestamp_seconds \d+/m);
  });
});

describe("/auth/verify (Traefik ForwardAuth)", () => {
  const verify = (app: Awaited<ReturnType<typeof setup>>["app"], lab: string | null, headers = {}) =>
    app.inject({ method: "GET", url: lab === null ? "/auth/verify" : `/auth/verify?lab=${lab}`, headers });

  it("answers 200 owner / 401 no session / 403 someone else", async () => {
    const { app, as } = await setup();
    const alice = await as("alice");
    const bob = await as("bob");
    const { labId } = (await app.inject({ method: "POST", url: "/api/labs", headers: alice })).json();

    expect((await verify(app, labId, alice)).statusCode).toBe(200);
    expect((await verify(app, labId)).statusCode).toBe(401);
    expect((await verify(app, labId, bob)).statusCode).toBe(403);
  });

  it("denies a lab that has expired, before the reaper gets to it", async () => {
    const { app, as, backend } = await setup();
    const alice = await as("alice");
    const { labId } = (await app.inject({ method: "POST", url: "/api/labs", headers: alice })).json();
    backend.labs[0]!.expires_at = new Date(Date.now() - 1000);
    expect((await verify(app, labId, alice)).statusCode).toBe(403);
  });

  it("denies an ended lab and a logged-out session", async () => {
    const { app, as } = await setup();
    const alice = await as("alice");
    const { labId } = (await app.inject({ method: "POST", url: "/api/labs", headers: alice })).json();
    await app.inject({ method: "DELETE", url: "/api/labs/me", headers: alice });
    expect((await verify(app, labId, alice)).statusCode).toBe(403);

    expect((await app.inject({ method: "POST", url: "/auth/logout", headers: alice })).statusCode).toBe(204);
    expect((await verify(app, labId, alice)).statusCode).toBe(401);
  });

  it("is 401 without a valid lab id (the Middleware always sends one)", async () => {
    const { app, as } = await setup();
    const alice = await as("alice");
    expect((await verify(app, null, alice)).statusCode).toBe(401);
    expect((await verify(app, "../etc", alice)).statusCode).toBe(401);
  });

  it("ignores X-Forwarded-Uri: the lab comes from the Middleware's ?lab=", async () => {
    const { app, as } = await setup();
    const alice = await as("alice");
    const bob = await as("bob");
    const aliceLab = (await app.inject({ method: "POST", url: "/api/labs", headers: alice })).json().labId;
    const bobLab = (await app.inject({ method: "POST", url: "/api/labs", headers: bob })).json().labId;
    // Bob claims the request is for his own lab while it's routed to Alice's.
    const res = await verify(app, aliceLab, { ...bob, "x-forwarded-uri": `/lab/${bobLab}/` });
    expect(res.statusCode).toBe(403);
  });

  it("answers every method (ForwardAuth mirrors the original request)", async () => {
    const { app, as } = await setup();
    const alice = await as("alice");
    const { labId } = (await app.inject({ method: "POST", url: "/api/labs", headers: alice })).json();
    for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS"] as const) {
      expect((await app.inject({ method, url: `/auth/verify?lab=${labId}`, headers: alice })).statusCode).toBe(200);
    }
  });
});

describe("auth + UI", () => {
  it("/auth/login is 503 until a Google client is configured", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/auth/login" })).statusCode).toBe(503);
  });

  it("/api/me returns the logged-in user", async () => {
    const { app, as } = await setup();
    const res = await app.inject({ method: "GET", url: "/api/me", headers: await as("alice") });
    expect(res.json()).toEqual({ id: "alice", email: "alice@example.test" });
  });

  it("serves the page with a strict CSP (no inline scripts)", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.body).toContain('<script src="/app.js"></script>');
    expect((await app.inject({ method: "GET", url: "/app.js" })).statusCode).toBe(200);
  });
});

describe("health + metrics", () => {
  it("/readyz reports each dependency and fails when one is down", async () => {
    const { app, k8s } = await setup();
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    k8s.ping.mockRejectedValueOnce(new Error("unreachable"));
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ db: true, k8s: false });
  });

  it("/healthz is always up", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
  });

  it("records lab and auth-verify metrics, and keeps /metrics off the public port", async () => {
    const { app, as } = await setup();
    const alice = await as("alice");
    const { labId } = (await app.inject({ method: "POST", url: "/api/labs", headers: alice })).json();
    await app.inject({ method: "GET", url: `/auth/verify?lab=${labId}`, headers: alice });
    const body = await registry.metrics();
    expect(body).toContain('labforge_lab_requests_total{result="created"}');
    expect(body).toContain("labforge_lab_start_duration_seconds_bucket");
    expect(body).toContain('labforge_auth_verify_duration_seconds_count{result="allowed"}');
    // Not on the public port: the Ingress routes "/" here.
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
  });
});
