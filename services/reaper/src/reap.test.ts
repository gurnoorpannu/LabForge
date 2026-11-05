import type { ClusterLab } from "@labforge/shared";
import { describe, expect, it, vi } from "vitest";
import { reap } from "./reap.js";

const NOW = 1_800_000_000;
const lab = (labId: string, expiresAt?: number, terminating = false): ClusterLab => ({
  labId, state: expiresAt ? "claimed" : "ready", expiresAt, createdAt: new Date(), terminating,
  pod: { ready: true, phase: "Running" },
});

function deps(labs: ClusterLab[]) {
  const k8s = { listLabs: vi.fn(async () => labs), deleteLab: vi.fn(async (_labId: string) => {}) };
  const store = { markDeleted: vi.fn(async (_ids: string | string[]) => 0), heartbeat: vi.fn(async (_name: string, _n?: number) => {}), deleteExpiredSessions: vi.fn(async () => 0) };
  return { k8s, store };
}

describe("reaper", () => {
  const labs = [
    lab("expired000000001", NOW - 5),
    lab("expiresnow000001", NOW),
    lab("future0000000001", NOW + 60),
    lab("warmnoexpiry0001"), // warm labs have no expiry; the pool controller recycles them
    lab("terminating00001", NOW - 5, true),
  ];

  it("deletes exactly the labs whose expires-at has passed", async () => {
    const { k8s, store } = deps(labs);
    const r = await reap(k8s, async () => store, NOW);
    expect(r.reaped).toEqual(["expired000000001", "expiresnow000001"]);
    expect(k8s.deleteLab.mock.calls.map((c) => c[0])).toEqual(["expired000000001", "expiresnow000001"]);
    expect(store.markDeleted).toHaveBeenCalledWith(["expired000000001", "expiresnow000001"]);
    expect(store.heartbeat).toHaveBeenCalledWith("reaper", 2);
  });

  it("still deletes expired labs when Postgres is down (annotations are the trigger)", async () => {
    const { k8s } = deps(labs);
    const r = await reap(k8s, async () => Promise.reject(new Error("ECONNREFUSED")), NOW);
    expect(r.reaped).toHaveLength(2);
    expect(k8s.deleteLab).toHaveBeenCalledTimes(2);
    expect(String(r.dbError)).toContain("ECONNREFUSED");
  });

  it("does not record a successful heartbeat if a deletion failed", async () => {
    const { k8s, store } = deps(labs);
    k8s.deleteLab.mockRejectedValueOnce(new Error("forbidden"));
    const r = await reap(k8s, async () => store, NOW);
    expect(r.failed).toEqual(["expired000000001"]);
    expect(store.heartbeat).not.toHaveBeenCalled();
  });
});
