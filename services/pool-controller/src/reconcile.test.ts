import { loadConfig, type ClusterLab, type KubernetesObject, type LabRow } from "@labforge/shared";
import { describe, expect, it } from "vitest";
import { reconcile, type ReconcileDeps } from "./reconcile.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000);

function world(env: Record<string, string> = {}) {
  const cfg = loadConfig({ DATABASE_URL: "x", NODE_CIDR: "172.28.0.0/16", POOL_SIZE: "3", ...env });
  const rows: LabRow[] = [];
  const cluster = new Map<string, ClusterLab>();
  const live = () => rows.filter((r) => !r.deleted_at);
  const row = (id: string, state: LabRow["state"], createdAgo = 0): LabRow => ({
    id, namespace: `lab-${id}`, state, owner_id: state === "claimed" ? "u" : null,
    started_from: null, created_at: ago(createdAgo), claimed_at: null,
    expires_at: state === "claimed" ? ago(-3600) : null, deleted_at: null,
  });
  const ns = (id: string, pod: ClusterLab["pod"], createdAgo = 0): ClusterLab => ({
    labId: id, state: undefined, expiresAt: undefined, createdAt: ago(createdAgo), terminating: false, pod,
  });

  const store: ReconcileDeps["store"] = {
    liveLabs: async () => live(),
    insertWarming: async (id, max) => {
      if (live().length >= max) return false;
      rows.push(row(id, "warming"));
      return true;
    },
    markReady: async (id) => {
      const r = live().find((x) => x.id === id && x.state === "warming");
      if (r) r.state = "ready";
    },
    retireUnclaimed: async (id) => {
      const r = live().find((x) => x.id === id && x.state !== "claimed");
      if (r) r.deleted_at = new Date(NOW);
      return Boolean(r);
    },
    markDeleted: async (ids) => {
      for (const id of [ids].flat()) {
        const r = live().find((x) => x.id === id);
        if (r) r.deleted_at = new Date(NOW);
      }
      return 0;
    },
  };
  const k8s: ReconcileDeps["k8s"] = {
    listLabs: async () => [...cluster.values()],
    applyLab: async (objs: KubernetesObject[]) => {
      const id = objs[0]!.metadata!.name!.replace(/^lab-/, "");
      cluster.set(id, ns(id, { ready: false, phase: "Pending" }));
    },
    deleteLab: async (id) => void cluster.delete(id),
  };
  const run = (extra: Partial<ReconcileDeps> = {}) => reconcile({ cfg, store, k8s, now: NOW, ...extra });
  const podsReady = () => {
    for (const c of cluster.values()) c.pod = { ready: true, phase: "Running" };
  };
  return { cfg, rows, cluster, live, row, ns, store, k8s, run, podsReady };
}

describe("pool controller reconcile", () => {
  it("fills an empty pool to POOL_SIZE and is idempotent while pods start", async () => {
    const w = world();
    expect((await w.run()).created).toHaveLength(3);
    expect(w.live().map((r) => r.state)).toEqual(["warming", "warming", "warming"]);
    // Pods still Pending: warming labs count toward the pool, nothing new is made.
    expect((await w.run()).created).toHaveLength(0);
  });

  it("marks warming labs ready once their pod is Ready", async () => {
    const w = world();
    await w.run();
    w.podsReady();
    expect((await w.run()).readied).toHaveLength(3);
    expect(w.live().every((r) => r.state === "ready")).toBe(true);
  });

  it("shrinks the pool when POOL_SIZE is lowered, retiring the oldest warm labs", async () => {
    const w = world({ POOL_SIZE: "1" });
    for (const [id, ageS] of [["warmold000000001", 900], ["warmmid000000001", 600], ["warmnew000000001", 300]] as const) {
      w.rows.push(w.row(id, "ready", ageS));
      w.cluster.set(id, w.ns(id, { ready: true, phase: "Running" }, ageS));
    }
    const r = await w.run();
    expect(r.retired).toEqual(["warmold000000001", "warmmid000000001"]);
    expect(r.created).toEqual([]);
    expect(w.live().map((x) => x.id)).toEqual(["warmnew000000001"]);
  });

  it("drains the pool completely at POOL_SIZE=0 but never touches claimed labs", async () => {
    const w = world({ POOL_SIZE: "0" });
    w.rows.push(w.row("warm000000000001", "ready", 60), w.row("claimed000000001", "claimed", 60));
    w.cluster.set("warm000000000001", w.ns("warm000000000001", { ready: true, phase: "Running" }, 60));
    w.cluster.set("claimed000000001", w.ns("claimed000000001", { ready: true, phase: "Running" }, 60));
    expect((await w.run()).retired).toEqual(["warm000000000001"]);
    expect(w.live().map((x) => x.id)).toEqual(["claimed000000001"]);
  });

  it("never exceeds the global cap (ready + claimed <= MAX_CONCURRENT_LABS)", async () => {
    const w = world({ MAX_CONCURRENT_LABS: "2" });
    w.rows.push(w.row("claimedlab000001", "claimed", 10));
    w.cluster.set("claimedlab000001", w.ns("claimedlab000001", { ready: true, phase: "Running" }, 10));
    expect((await w.run()).created).toHaveLength(1);
    expect(w.live()).toHaveLength(2);
  });

  it("recycles warm labs past POOL_MAX_AGE and replaces them in the same pass", async () => {
    const w = world({ POOL_SIZE: "1", POOL_MAX_AGE: "6h" });
    w.rows.push(w.row("oldwarmlab000001", "ready", 7 * 3600));
    w.cluster.set("oldwarmlab000001", w.ns("oldwarmlab000001", { ready: true, phase: "Running" }, 7 * 3600));
    const r = await w.run();
    expect(r.retired).toEqual(["oldwarmlab000001"]);
    expect(w.cluster.has("oldwarmlab000001")).toBe(false);
    expect(r.created).toHaveLength(1);
  });

  it("recycles warm labs whose pod died (e.g. node restart)", async () => {
    const w = world({ POOL_SIZE: "1" });
    w.rows.push(w.row("deadwarmlab00001", "ready", 600));
    w.cluster.set("deadwarmlab00001", w.ns("deadwarmlab00001", { ready: false, phase: "Failed" }, 600));
    expect((await w.run()).retired).toEqual(["deadwarmlab00001"]);
  });

  it("gives up on a warming lab that never becomes Ready", async () => {
    const w = world({ POOL_SIZE: "0" });
    w.rows.push(w.row("stuckwarming0001", "warming", 400));
    w.cluster.set("stuckwarming0001", w.ns("stuckwarming0001", { ready: false, phase: "Pending" }, 400));
    expect((await w.run()).retired).toEqual(["stuckwarming0001"]);
  });

  it("frees a user's slot when their lab pod is gone (deadline, eviction)", async () => {
    const w = world({ POOL_SIZE: "0" });
    w.rows.push(w.row("claimedlab000001", "claimed", 3000));
    w.cluster.set("claimedlab000001", w.ns("claimedlab000001", { ready: false, phase: "Failed" }, 3000));
    const r = await w.run();
    expect(r.endedClaimed).toEqual(["claimedlab000001"]);
    expect(w.live()).toHaveLength(0);
    expect(w.cluster.size).toBe(0);
  });

  it("deletes namespaces with no DB row, but only after the grace period", async () => {
    const w = world({ POOL_SIZE: "0" });
    w.cluster.set("orphanold0000001", w.ns("orphanold0000001", null, 600));
    w.cluster.set("orphannew0000001", w.ns("orphannew0000001", null, 30)); // may be mid-create
    expect((await w.run()).orphanNamespaces).toEqual(["orphanold0000001"]);
    expect(w.cluster.has("orphannew0000001")).toBe(true);
  });

  it("marks DB rows deleted when their namespace is gone, after the grace period", async () => {
    const w = world({ POOL_SIZE: "0" });
    w.rows.push(w.row("gonelab000000001", "claimed", 600), w.row("newlab0000000001", "claimed", 30));
    expect((await w.run()).rowsWithoutNamespace).toEqual(["gonelab000000001"]);
    expect(w.live().map((r) => r.id)).toEqual(["newlab0000000001"]);
  });

  it("never takes a lab a user claimed between observe and act", async () => {
    const w = world({ POOL_SIZE: "1", POOL_MAX_AGE: "6h" });
    w.rows.push(w.row("racedlab00000001", "ready", 7 * 3600));
    w.cluster.set("racedlab00000001", w.ns("racedlab00000001", { ready: true, phase: "Running" }, 7 * 3600));
    const liveLabs = w.store.liveLabs;
    w.store.liveLabs = async () => {
      const snapshot = (await liveLabs()).map((r) => ({ ...r }));
      w.rows.find((r) => r.id === "racedlab00000001")!.state = "claimed"; // user wins the race
      return snapshot;
    };
    const r = await w.run();
    expect(r.retired).toEqual([]);
    expect(w.cluster.has("racedlab00000001")).toBe(true);
  });

  it("rolls back a warm lab whose objects fail to create", async () => {
    const w = world({ POOL_SIZE: "1" });
    w.k8s.applyLab = async () => {
      throw new Error("apiserver down");
    };
    await expect(w.run()).rejects.toThrow("apiserver down");
    expect(w.live()).toHaveLength(0);
  });
});
