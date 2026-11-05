import {
  ApiException,
  CoreV1Api,
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
  setHeaderOptions,
  VersionApi,
  type KubernetesObject,
} from "@kubernetes/client-node";
import { labNamespace } from "./ids.js";
import { ANNOTATION, EXPIRY_GRACE_SECONDS, LAB_POD_NAME, LABEL, MANAGED_BY } from "./labManifest.js";

/** What the controllers need to know about one lab namespace in the cluster. */
export interface ClusterLab {
  labId: string;
  state: string | undefined; // labforge.io/state label
  expiresAt: number | undefined; // unix seconds, from the annotation
  createdAt: Date;
  terminating: boolean;
  pod: { ready: boolean; phase: string | undefined } | null; // null = no pod
}

const MANAGED = `${LABEL.managedBy}=${MANAGED_BY}`;
const mergePatch = setHeaderOptions("Content-Type", PatchStrategy.MergePatch);

/**
 * activeDeadlineSeconds counts from the pod's *start*, not from now. A warm pod
 * that sat in the pool for hours needs its age added, or it would die early.
 */
export function deadlineFromStart(podStartTime: Date, expiresAt: number): number {
  return Math.max(1, Math.ceil(expiresAt + EXPIRY_GRACE_SECONDS - podStartTime.getTime() / 1000));
}

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

    /**
     * Turn a warm lab into a user's lab (the Ingress + Middleware are created
     * separately with applyLab(buildLabRoute(...))): label + annotate the
     * namespace, mirror the expiry onto the pod (downward API file -> MOTD), and
     * set the pod's activeDeadlineSeconds safety net.
     */
    async markClaimed(labId: string, ownerId: string, expiresAt: number): Promise<void> {
      const namespace = labNamespace(labId);
      const annotations = { [ANNOTATION.expiresAt]: String(expiresAt), [ANNOTATION.owner]: ownerId };
      // JSON merge patches with plain bodies: only the named fields change.
      await core.patchNamespace(
        { name: namespace, body: { metadata: { labels: { [LABEL.state]: "claimed" }, annotations } } },
        mergePatch,
      );
      const pod = await core.readNamespacedPod({ name: LAB_POD_NAME, namespace });
      const started = pod.status?.startTime ? new Date(pod.status.startTime) : new Date();
      await core.patchNamespacedPod(
        {
          name: LAB_POD_NAME,
          namespace,
          body: {
            metadata: { annotations },
            // Allowed on a running pod: Kubernetes lets activeDeadlineSeconds be
            // set or lowered after creation (never raised or removed).
            spec: { activeDeadlineSeconds: deadlineFromStart(started, expiresAt) },
          },
        },
        mergePatch,
      );
    },

    /** Every LabForge namespace plus the state of its lab pod. Two list calls total. */
    async listLabs(): Promise<ClusterLab[]> {
      const [nss, pods] = await Promise.all([
        core.listNamespace({ labelSelector: MANAGED }),
        core.listPodForAllNamespaces({ labelSelector: MANAGED }),
      ]);
      const podByNs = new Map(pods.items.map((p) => [p.metadata?.namespace, p]));
      return nss.items.flatMap((ns) => {
        const labId = ns.metadata?.labels?.[LABEL.labId];
        if (!labId) return [];
        const pod = podByNs.get(ns.metadata!.name);
        const exp = ns.metadata?.annotations?.[ANNOTATION.expiresAt];
        return [{
          labId,
          state: ns.metadata?.labels?.[LABEL.state],
          expiresAt: exp ? Number(exp) : undefined,
          createdAt: new Date(ns.metadata?.creationTimestamp ?? Date.now()),
          terminating: Boolean(ns.metadata?.deletionTimestamp),
          pod: pod
            ? {
                ready: pod.status?.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false,
                phase: pod.status?.phase,
              }
            : null,
        }];
      });
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
