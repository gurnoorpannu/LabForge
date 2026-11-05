// Real k3d + Postgres. Skipped unless INTEGRATION=1.
// The pool controller's reconcile loop and the reaper, end to end: warm pool
// fills and refills, a warm claim, drift repair both ways, reaping by annotation.
import {
  buildLab,
  buildLabRoute,
  createK8s,
  createLabStore,
  createPool,
  loadConfig,
  migrate,
  newLabId,
  type LabStore,
} from "@labforge/shared";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcile } from "../../services/pool-controller/src/reconcile.js";
import { reap } from "../../services/reaper/src/reap.js";

const enabled = process.env.INTEGRATION === "1";

describe.skipIf(!enabled)("warm pool + reaper lifecycle (k3d + Postgres)", () => {
  const k8s = createK8s();
  const cfg = loadConfig({
    DATABASE_URL: "postgres://labforge:labforge@localhost:5432/labforge",
    NODE_CIDR: "172.28.0.0/16",
    ...process.env,
    POOL_SIZE: "2",
    MAX_CONCURRENT_LABS: "5",
  });
  let pool: pg.Pool;
  let store: LabStore;
  // grace 0: this test owns the cluster's labs and runs passes one at a time.
  const pass = () => reconcile({ cfg, store, k8s, graceSeconds: 0 });
  const until = async (what: string, cond: () => Promise<boolean>, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await pass();
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`timed out waiting for: ${what}`);
  };
  const stats = () => store.stats();

  beforeAll(async () => {
    pool = createPool(cfg.databaseUrl);
    await migrate(pool);
    store = createLabStore(pool);
    await pool.query("UPDATE labs SET deleted_at = now() WHERE deleted_at IS NULL"); // clean slate
  });

  afterAll(async () => {
    const live = await store.liveLabs();
    await store.markDeleted(live.map((l) => l.id));
    await Promise.all(live.map((l) => k8s.deleteLab(l.id)));
    await pass(); // removes any namespace left without a row
    await pool.end();
  });

  let claimedId = "";

  it("fills the pool to POOL_SIZE ready labs", async () => {
    await until("2 ready", async () => (await stats()).ready === 2);
    expect(await stats()).toEqual({ warming: 0, ready: 2, claimed: 0 });
  }, 150_000);

  it("serves a start from the pool, then refills it", async () => {
    await store.upsertUser("lifecycle-user", null);
    const res = await store.reserveLab({ newLabId: newLabId(), ownerId: "lifecycle-user", ttlSeconds: 120, maxLabs: 5 });
    expect(res.ok && res.lab.started_from).toBe("warm");
    claimedId = res.ok ? res.lab.id : "";
    const expiresAt = Math.floor(Date.now() / 1000) + 120;
    // What the API does. The route was created with the warm lab (ADR-0009), so
    // the idempotent create is a no-op (409 ignored).
    await k8s.markClaimed(claimedId, "lifecycle-user", expiresAt);
    await k8s.applyLab(buildLabRoute(cfg, claimedId), { ignoreExisting: true });

    await until("pool refilled", async () => {
      const s = await stats();
      return s.ready === 2 && s.claimed === 1;
    });
    const lab = (await k8s.listLabs()).find((l) => l.labId === claimedId);
    expect(lab).toMatchObject({ state: "claimed", expiresAt });
  }, 150_000);

  it("repairs a DB row whose namespace was deleted behind its back", async () => {
    const victim = (await store.liveLabs()).find((l) => l.state === "ready")!;
    await k8s.deleteLab(victim.id);
    await until("row marked deleted", async () => !(await store.liveLabs()).some((l) => l.id === victim.id));
    await until("pool back to 2", async () => (await stats()).ready === 2);
  }, 200_000);

  it("deletes a namespace that has no DB row", async () => {
    const orphan = newLabId();
    await k8s.applyLab(buildLab(cfg, { labId: orphan, state: "ready" }));
    const r = await pass();
    expect(r.orphanNamespaces).toContain(orphan);
  });

  it("reaper deletes the expired lab by its annotation and records a heartbeat", async () => {
    const lab = (await k8s.listLabs()).find((l) => l.labId === claimedId)!;
    const before = (await store.getHeartbeat("reaper"))?.total ?? 0;
    // Pretend the clock passed the expiry; the trigger is the namespace annotation.
    const r = await reap(k8s, async () => store, lab.expiresAt! + 1);
    expect(r.reaped).toEqual([claimedId]);
    expect(r.dbError).toBeNull();
    expect((await store.liveLabs()).some((l) => l.id === claimedId)).toBe(false);
    const hb = await store.getHeartbeat("reaper");
    expect(hb!.total).toBe(before + 1);
    expect(Date.now() - hb!.lastSuccess.getTime()).toBeLessThan(10_000);
  });
});
