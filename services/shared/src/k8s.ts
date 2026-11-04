import {
  ApiException,
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
  VersionApi,
  type KubernetesObject,
} from "@kubernetes/client-node";
import { labNamespace } from "./ids.js";
import { LAB_POD_NAME } from "./labManifest.js";

export const isNotFound = (err: unknown): boolean =>
  err instanceof ApiException && err.code === 404;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-cluster service account when running in a pod, else ~/.kube/config (k3d locally). */
export function createK8s(kc: KubeConfig = defaultKubeConfig()) {
  const objects = KubernetesObjectApi.makeApiClient(kc);
  const core = kc.makeApiClient(CoreV1Api);
  const version = kc.makeApiClient(VersionApi);

  return {
    /** Create objects in order. The namespace comes first, so later objects can land in it. */
    async applyLab(specs: KubernetesObject[]): Promise<void> {
      for (const spec of specs) await objects.create(spec);
    },

    /** Deleting the namespace garbage-collects everything in it. Idempotent. */
    async deleteLab(labId: string): Promise<void> {
      try {
        await core.deleteNamespace({ name: labNamespace(labId), propagationPolicy: "Background" });
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },

    async namespaceExists(labId: string): Promise<boolean> {
      try {
        await core.readNamespace({ name: labNamespace(labId) });
        return true;
      } catch (err) {
        if (isNotFound(err)) return false;
        throw err;
      }
    },

    /** Poll until the lab pod reports Ready. Returns false on timeout. */
    async waitForPodReady(labId: string, timeoutMs: number, pollMs = 500): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const pod = await core.readNamespacedPod({
            name: LAB_POD_NAME,
            namespace: labNamespace(labId),
          });
          const ready = pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True");
          if (ready) return true;
        } catch (err) {
          if (!isNotFound(err)) throw err; // not created yet is fine; anything else is real
        }
        await sleep(pollMs);
      }
      return false;
    },

    /** Cheap reachability check for /readyz. /version needs no RBAC grant. */
    async ping(): Promise<void> {
      await version.getCode();
    },
  };
}

export type K8s = ReturnType<typeof createK8s>;

function defaultKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc;
}
