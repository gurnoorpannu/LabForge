// Real k3d. Skipped unless INTEGRATION=1.
// The spec's open question: can activeDeadlineSeconds be patched onto a pod
// that is already running (a warm lab being claimed)? And does the kubelet then
// kill it with no reaper involved? This is the second cleanup layer.
import { buildLab, createK8s, deadlineFromStart, labNamespace, loadConfig, newLabId } from "@labforge/shared";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { afterAll, describe, expect, it } from "vitest";

const enabled = process.env.INTEGRATION === "1";

describe.skipIf(!enabled)("claiming a warm lab (k3d)", () => {
  const k8s = createK8s();
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(CoreV1Api);
  const cfg = loadConfig({ DATABASE_URL: "x", NODE_CIDR: "172.28.0.0/16", SESSION_SECRET: "x".repeat(32), ...process.env });
  const labId = newLabId();
  const namespace = labNamespace(labId);

  afterAll(() => k8s.deleteLab(labId));

  it("patches activeDeadlineSeconds onto a running pod, and the kubelet enforces it", async () => {
    await k8s.applyLab(buildLab(cfg, { labId, state: "ready" }));
    expect(await k8s.waitForPodReady(labId, 120_000)).toBe(true);
    const before = await core.readNamespacedPod({ name: "lab", namespace });
    expect(before.spec?.activeDeadlineSeconds).toBeUndefined(); // warm pods have none

    // Claim with an expiry such that the deadline (expiry + 60s grace) lands ~20s out.
    const expiresAt = Math.floor(Date.now() / 1000) - 60 + 20;
    await k8s.markClaimed(labId, "warm-claim-test", expiresAt);

    const after = await core.readNamespacedPod({ name: "lab", namespace });
    const started = new Date(after.status!.startTime!);
    expect(after.spec?.activeDeadlineSeconds).toBe(deadlineFromStart(started, expiresAt));
    expect(after.metadata?.annotations?.["labforge.io/expires-at"]).toBe(String(expiresAt));
    expect(after.metadata?.annotations?.["labforge.io/owner"]).toBe("warm-claim-test");
    const ns = await core.readNamespace({ name: namespace });
    expect(ns.metadata?.labels?.["labforge.io/state"]).toBe("claimed");

    // No reaper runs here: the kubelet alone must end the pod.
    let status = { phase: "", reason: "" };
    for (let i = 0; i < 60 && status.phase !== "Failed"; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const p = await core.readNamespacedPod({ name: "lab", namespace });
      status = { phase: p.status?.phase ?? "", reason: p.status?.reason ?? "" };
    }
    expect(status).toEqual({ phase: "Failed", reason: "DeadlineExceeded" });
  }, 240_000);
});
