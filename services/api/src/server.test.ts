import { loadConfig, type K8s, type LabRow, type LabStore } from "@labforge/shared";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";

// In-memory stand-in with the same rules as the SQL (existing -> capacity -> insert).
// The SQL itself is exercised against real Postgres by tests/integration.
function memoryStore(): LabStore {
  const labs: LabRow[] = [];
  const active = (owner: string) =>
    labs.find((l) => l.owner_id === owner && l.state === "claimed" && !l.deleted_at) ?? null;
  return {
    ping: async () => {},
    upsertUser: async () => {},
    audit: async () => {},
    getActiveLab: async (owner) => active(owner),
    markDeleted: async (id) => {
      const lab = labs.find((l) => l.id === id);
      if (lab && !lab.deleted_at) lab.deleted_at = new Date();
    },
    reserveColdLab: async ({ labId, ownerId, ttlSeconds, maxLabs }) => {
      const existing = active(ownerId);
      if (existing) return { ok: false, reason: "existing", lab: existing };
      if (labs.filter((l) => !l.deleted_at).length >= maxLabs) return { ok: false, reason: "capacity" };
      const now = new Date();
      const lab: LabRow = {
        id: labId,
        namespace: `lab-${labId}`,
        state: "claimed",
        owner_id: ownerId,
        started_from: "cold",
        created_at: now,
        claimed_at: now,
        expires_at: new Date(now.getTime() + ttlSeconds * 1000),
        deleted_at: null,
      };
      labs.push(lab);
      return { ok: true, lab };
    },
  };
}

function fakeK8s(): K8s & { [K in keyof K8s]: ReturnType<typeof vi.fn> } {
  return {
    applyLab: vi.fn(async () => {}),
    deleteLab: vi.fn(async () => {}),
    namespaceExists: vi.fn(async () => true),
    waitForPodReady: vi.fn(async () => true),
    ping: vi.fn(async () => {}),
  };
}

async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://x",
    DEV_FAKE_AUTH: "true",
    PUBLIC_BASE_URL: "https://labs.example.test",
    ...env,
  });
  const k8s = fakeK8s();
  const app = await buildServer({ config, store: memoryStore(), k8s, logger: false });
  const as = (user: string) => ({ "x-dev-user": user });
  return { app, k8s, as };
}

describe("lab API", () => {
  it("rejects anonymous callers", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/labs" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/labs/me" })).statusCode).toBe(401);
  });

  it("ignores the dev header unless DEV_FAKE_AUTH is on", async () => {
    const { app, as } = await setup({ DEV_FAKE_AUTH: "false" });
    const res = await app.inject({ method: "POST", url: "/api/labs", headers: as("alice") });
    expect(res.statusCode).toBe(401);
  });

  it("cold-starts a lab and returns its URL", async () => {
    const { app, k8s, as } = await setup();
    const res = await app.inject({ method: "POST", url: "/api/labs", headers: as("alice") });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.labId).toMatch(/^[a-z2-7]{16}$/);
    expect(body).toMatchObject({
      url: `https://labs.example.test/lab/${body.labId}`,
      startedFrom: "cold",
      ready: true,
    });
    const kinds = k8s.applyLab.mock.calls[0]![0].map((o: { kind: string }) => o.kind);
    expect(kinds).toContain("Ingress");
  });

  it("allows one active lab per user (409 with the existing lab)", async () => {
    const { app, as } = await setup();
    const first = (await app.inject({ method: "POST", url: "/api/labs", headers: as("alice") })).json();
    const second = await app.inject({ method: "POST", url: "/api/labs", headers: as("alice") });
    expect(second.statusCode).toBe(409);
    expect(second.json().lab.labId).toBe(first.labId);
  });

  it("returns 503 + Retry-After when the cluster is at capacity", async () => {
    const { app, as } = await setup({ MAX_CONCURRENT_LABS: "1" });
    await app.inject({ method: "POST", url: "/api/labs", headers: as("alice") });
    const res = await app.inject({ method: "POST", url: "/api/labs", headers: as("bob") });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.json().error).toBe("at_capacity");
  });

  it("rolls back the namespace and the DB row when Kubernetes fails", async () => {
    const { app, k8s, as } = await setup();
    k8s.applyLab.mockRejectedValueOnce(new Error("boom"));
    const res = await app.inject({ method: "POST", url: "/api/labs", headers: as("alice") });
    expect(res.statusCode).toBe(500);
    expect(k8s.deleteLab).toHaveBeenCalledOnce();
    // The failed lab doesn't block a retry.
    expect((await app.inject({ method: "GET", url: "/api/labs/me", headers: as("alice") })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/labs", headers: as("alice") })).statusCode).toBe(201);
  });

  it("gets and ends the current lab", async () => {
    const { app, k8s, as } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/labs/me", headers: as("alice") })).statusCode).toBe(404);
    const { labId } = (await app.inject({ method: "POST", url: "/api/labs", headers: as("alice") })).json();

    const me = await app.inject({ method: "GET", url: "/api/labs/me", headers: as("alice") });
    expect(me.json().labId).toBe(labId);

    const del = await app.inject({ method: "DELETE", url: "/api/labs/me", headers: as("alice") });
    expect(del.statusCode).toBe(204);
    expect(k8s.deleteLab).toHaveBeenCalledWith(labId);
    expect((await app.inject({ method: "GET", url: "/api/labs/me", headers: as("alice") })).statusCode).toBe(404);
  });

  it("rate-limits lab starts per user", async () => {
    const { app, as } = await setup({ RATE_LIMIT_PER_MIN: "2" });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push((await app.inject({ method: "POST", url: "/api/labs", headers: as("alice") })).statusCode);
    }
    expect(codes).toEqual([201, 409, 429]);
    // A different user has their own budget.
    expect((await app.inject({ method: "POST", url: "/api/labs", headers: as("bob") })).statusCode).toBe(201);
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

  it("/metrics exposes the lab counters in Prometheus format", async () => {
    const { app, as } = await setup();
    await app.inject({ method: "POST", url: "/api/labs", headers: as("alice") });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain('labforge_lab_requests_total{result="created"}');
    expect(res.body).toContain("labforge_lab_start_duration_seconds_bucket");
  });
});
