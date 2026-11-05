import {
  buildLab,
  newLabId,
  type ClusterLab,
  type Config,
  type K8s,
  type LabRow,
  type LabStore,
} from "@labforge/shared";

export interface ReconcileDeps {
  cfg: Config;
  store: Pick<LabStore, "liveLabs" | "insertWarming" | "markReady" | "retireUnclaimed" | "markDeleted">;
  k8s: Pick<K8s, "listLabs" | "applyLab" | "deleteLab">;
  /** Objects younger than this are left alone: they may be mid-creation. */
  graceSeconds?: number;
  /** A warming lab whose pod isn't Ready by now is given up on. */
  warmTimeoutSeconds?: number;
  now?: number; // ms
}

export interface ReconcileResult {
  created: string[];
  readied: string[];
  retired: string[]; // unclaimed labs removed (stale, too old, pod dead)
  endedClaimed: string[]; // claimed labs whose pod is gone (deadline, eviction, node loss)
  orphanNamespaces: string[]; // namespace with no DB row
  rowsWithoutNamespace: string[]; // DB row with no namespace
}

const POD_DONE = new Set(["Failed", "Succeeded"]);

/**
 * One pass of the control loop: observe the DB (source of truth for
 * assignment) and the cluster, fix drift in both directions, then grow or
 * shrink the warm pool to poolSize (growing only within the global cap). Idempotent: running it twice in a
 * row changes nothing the second time.
 */
export async function reconcile({
  cfg,
  store,
  k8s,
  graceSeconds = 120,
  warmTimeoutSeconds = 300,
  now = Date.now(),
}: ReconcileDeps): Promise<ReconcileResult> {
  const r: ReconcileResult = {
    created: [],
    readied: [],
    retired: [],
    endedClaimed: [],
    orphanNamespaces: [],
    rowsWithoutNamespace: [],
  };
  const age = (d: Date) => (now - d.getTime()) / 1000;
  const [rows, cluster] = await Promise.all([store.liveLabs(), k8s.listLabs()]);
  const inCluster = new Map(cluster.map((c) => [c.labId, c]));
  const inDb = new Set(rows.map((row) => row.id));

  // Drift 1: a namespace nobody owns in the DB (crash mid-create, manual edits).
  for (const c of cluster) {
    if (!inDb.has(c.labId) && !c.terminating && age(c.createdAt) > graceSeconds) {
      await k8s.deleteLab(c.labId);
      r.orphanNamespaces.push(c.labId);
    }
  }

  const retire = async (row: LabRow) => {
    // Only wins while still unclaimed, so it can never take a lab from a user.
    if (await store.retireUnclaimed(row.id)) {
      await k8s.deleteLab(row.id);
      r.retired.push(row.id);
    }
  };

  const pooled: LabRow[] = []; // warming + ready labs that survive this pass
  for (const row of rows) {
    const c = inCluster.get(row.id);

    // Drift 2: the DB thinks a lab exists but its namespace is gone (e.g. the
    // reaper deleted it while Postgres was down).
    if (!c || c.terminating) {
      if (age(row.created_at) > graceSeconds) {
        await store.markDeleted(row.id);
        r.rowsWithoutNamespace.push(row.id);
      } else if (row.state !== "claimed") pooled.push(row);
      continue;
    }

    const podDead = isPodDead(c, graceSeconds, age);
    if (row.state === "claimed") {
      // The lab is over (activeDeadlineSeconds fired, evicted, node lost): free
      // the user's slot now rather than at expiry.
      if (podDead) {
        await store.markDeleted(row.id);
        await k8s.deleteLab(row.id);
        r.endedClaimed.push(row.id);
      }
      continue;
    }

    if (row.state === "warming") {
      if (c.pod?.ready) {
        await store.markReady(row.id);
        r.readied.push(row.id);
        pooled.push(row);
      } else if (podDead || age(row.created_at) > warmTimeoutSeconds) {
        await retire(row);
      } else pooled.push(row);
      continue;
    }

    // ready: recycle dead pods and labs past their max age.
    if (podDead || age(row.created_at) > cfg.lab.poolMaxAgeSeconds) await retire(row);
    else pooled.push(row);
  }

  // Shrink: POOL_SIZE was lowered. Retire the oldest unclaimed labs first.
  const excess = pooled.length - cfg.lab.poolSize;
  if (excess > 0) {
    const oldest = [...pooled].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    for (const row of oldest.slice(0, excess)) await retire(row);
  }

  // Top up the pool. insertWarming enforces the global cap under the same lock
  // the API uses, so the pool can never push the cluster past MAX_CONCURRENT_LABS.
  for (let i = pooled.length; i < cfg.lab.poolSize; i++) {
    const labId = newLabId();
    if (!(await store.insertWarming(labId, cfg.lab.maxConcurrent))) break; // at capacity
    try {
      await k8s.applyLab(buildLab(cfg, { labId, state: "ready" }));
      r.created.push(labId);
    } catch (err) {
      await store.retireUnclaimed(labId);
      await k8s.deleteLab(labId).catch(() => {});
      throw err;
    }
  }
  return r;
}

function isPodDead(c: ClusterLab, graceSeconds: number, age: (d: Date) => number): boolean {
  if (c.pod === null) return age(c.createdAt) > graceSeconds; // never created / deleted
  return c.pod.phase !== undefined && POD_DONE.has(c.pod.phase);
}

export const isNoop = (r: ReconcileResult) => Object.values(r).every((v) => v.length === 0);
