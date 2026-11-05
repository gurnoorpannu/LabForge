import type { K8s, LabStore } from "@labforge/shared";

export interface ReapResult {
  reaped: string[]; // namespaces deleted
  failed: string[]; // namespaces that couldn't be deleted (retried next run)
  dbError: unknown; // bookkeeping failed; deletions still happened
}

/**
 * Delete every lab whose labforge.io/expires-at annotation has passed.
 *
 * The trigger is the annotation in the cluster, not Postgres, so expired labs
 * are removed even while the database is down. DB bookkeeping (rows, heartbeat,
 * old sessions) happens afterwards and its failure is reported, not fatal; the
 * pool controller later marks rows whose namespace is gone.
 */
export async function reap(
  k8s: Pick<K8s, "listLabs" | "deleteLab">,
  connectStore: () => Promise<Pick<LabStore, "markDeleted" | "heartbeat" | "deleteExpiredSessions">>,
  nowSeconds = Date.now() / 1000,
): Promise<ReapResult> {
  const result: ReapResult = { reaped: [], failed: [], dbError: null };
  const expired = (await k8s.listLabs()).filter(
    (l) => l.expiresAt !== undefined && l.expiresAt <= nowSeconds && !l.terminating,
  );
  for (const lab of expired) {
    try {
      await k8s.deleteLab(lab.labId);
      result.reaped.push(lab.labId);
    } catch {
      result.failed.push(lab.labId);
    }
  }
  try {
    const store = await connectStore();
    await store.markDeleted(result.reaped);
    await store.deleteExpiredSessions();
    // Only a fully clean run counts as success for the ReaperStale alert.
    if (result.failed.length === 0) await store.heartbeat("reaper", result.reaped.length);
  } catch (err) {
    result.dbError = err;
  }
  return result;
}
