import type {
  KubernetesObject,
  V1Ingress,
  V1LimitRange,
  V1Namespace,
  V1NetworkPolicy,
  V1NetworkPolicyEgressRule,
  V1Pod,
  V1ResourceQuota,
  V1Service,
} from "@kubernetes/client-node";
import type { Config } from "./config.js";
import { labNamespace } from "./ids.js";

export const LABEL = {
  managedBy: "app.kubernetes.io/managed-by",
  labId: "labforge.io/lab-id",
  state: "labforge.io/state",
} as const;

export const ANNOTATION = {
  expiresAt: "labforge.io/expires-at", // unix seconds
  owner: "labforge.io/owner",
} as const;

export const MANAGED_BY = "labforge";
export const LAB_POD_NAME = "lab";
export const TTYD_PORT = 7681;
/** Pod outlives its expiry by this much, so the reaper normally wins the race. */
export const EXPIRY_GRACE_SECONDS = 60;

export type LabState = "ready" | "claimed";

export interface LabParams {
  labId: string;
  state: LabState;
  ownerId?: string;
  /** Unix seconds. Required when state is "claimed". */
  expiresAt?: number;
  /** Unix seconds; injectable so snapshot tests are deterministic. */
  now?: number;
}

/**
 * Every object for one lab, in apply order (namespace first).
 * A "ready" (warm) lab has no Ingress: nobody can reach it until it is claimed.
 */
export function buildLab(cfg: Config, p: LabParams): KubernetesObject[] {
  if (p.state === "claimed" && (p.expiresAt === undefined || p.ownerId === undefined)) {
    throw new Error("claimed labs need ownerId and expiresAt");
  }
  const objects: KubernetesObject[] = [
    namespace(p),
    resourceQuota(cfg, p),
    limitRange(cfg, p),
    networkPolicy(cfg, p),
    pod(cfg, p),
    service(p),
  ];
  if (p.state === "claimed") objects.push(buildLabIngress(cfg, p.labId));
  return objects;
}

function labels(p: LabParams): Record<string, string> {
  return { [LABEL.managedBy]: MANAGED_BY, [LABEL.labId]: p.labId };
}

function annotations(p: LabParams): Record<string, string> {
  const a: Record<string, string> = {};
  if (p.expiresAt !== undefined) a[ANNOTATION.expiresAt] = String(p.expiresAt);
  if (p.ownerId !== undefined) a[ANNOTATION.owner] = p.ownerId;
  return a;
}

function namespace(p: LabParams): V1Namespace {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: labNamespace(p.labId),
      labels: {
        ...labels(p),
        [LABEL.state]: p.state,
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": "latest",
      },
      annotations: annotations(p),
    },
  };
}

function resourceQuota(cfg: Config, p: LabParams): V1ResourceQuota {
  const { requests, limits } = cfg.lab.resources;
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: { name: "lab-quota", namespace: labNamespace(p.labId), labels: labels(p) },
    spec: {
      hard: {
        pods: "2", // one lab pod + slack while a pod is terminating
        "requests.cpu": requests.cpu,
        "requests.memory": requests.memory,
        "requests.ephemeral-storage": requests["ephemeral-storage"],
        "limits.cpu": limits.cpu,
        "limits.memory": limits.memory,
        "limits.ephemeral-storage": limits["ephemeral-storage"],
      },
    },
  };
}

function limitRange(cfg: Config, p: LabParams): V1LimitRange {
  const { requests, limits } = cfg.lab.resources;
  return {
    apiVersion: "v1",
    kind: "LimitRange",
    metadata: { name: "lab-limits", namespace: labNamespace(p.labId), labels: labels(p) },
    spec: {
      limits: [
        {
          type: "Container",
          _default: { ...limits }, // client-node models `default` as `_default`
          defaultRequest: { ...requests },
          max: { cpu: limits.cpu, memory: limits.memory },
        },
      ],
    },
  };
}

function networkPolicy(cfg: Config, p: LabParams): V1NetworkPolicy {
  const n = cfg.network;
  const egress: V1NetworkPolicyEgressRule[] = [
    {
      // DNS to CoreDNS only.
      to: [
        {
          namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
          podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
        },
      ],
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    },
  ];
  if (n.internetEgress) {
    egress.push({
      to: [
        {
          ipBlock: {
            cidr: "0.0.0.0/0",
            // Internet yes; cluster internals and cloud metadata no.
            except: [n.podCidr, n.serviceCidr, ...(n.nodeCidr ? [n.nodeCidr] : []), n.metadataCidr],
          },
        },
      ],
    });
  }
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "lab-isolation", namespace: labNamespace(p.labId), labels: labels(p) },
    spec: {
      podSelector: {}, // every pod in the namespace; default-deny both ways
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          // Only the ingress controller may reach ttyd.
          _from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": cfg.ingress.namespace },
              },
            },
          ],
          ports: [{ protocol: "TCP", port: TTYD_PORT }],
        },
      ],
      egress,
    },
  };
}

function pod(cfg: Config, p: LabParams): V1Pod {
  const now = p.now ?? Math.floor(Date.now() / 1000);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: LAB_POD_NAME,
      namespace: labNamespace(p.labId),
      labels: labels(p),
      // Mirrored onto the pod so the downward API volume below can expose it.
      annotations: annotations(p),
    },
    spec: {
      // Safety net independent of the reaper: kubelet kills the pod at expiry + grace.
      // Warm labs get this patched in on claim (Phase 5).
      ...(p.expiresAt !== undefined && {
        activeDeadlineSeconds: Math.max(1, p.expiresAt - now + EXPIRY_GRACE_SECONDS),
      }),
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "terminal",
          image: cfg.lab.image,
          imagePullPolicy: cfg.lab.imagePullPolicy,
          ports: [{ containerPort: TTYD_PORT, name: "ttyd" }],
          env: [{ name: "LAB_ID", value: p.labId }],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            runAsUser: 1000,
            capabilities: { drop: ["ALL"] },
            seccompProfile: { type: "RuntimeDefault" },
          },
          resources: {
            requests: { ...cfg.lab.resources.requests },
            limits: { ...cfg.lab.resources.limits },
          },
          readinessProbe: {
            tcpSocket: { port: TTYD_PORT },
            initialDelaySeconds: 1,
            periodSeconds: 2,
          },
          volumeMounts: [
            { name: "home", mountPath: "/home/lab" },
            { name: "tmp", mountPath: "/tmp" },
            { name: "labinfo", mountPath: "/etc/labforge", readOnly: true },
          ],
        },
      ],
      volumes: [
        { name: "home", emptyDir: {} },
        { name: "tmp", emptyDir: {} },
        {
          // Annotation changes show up in this file live, unlike env vars.
          name: "labinfo",
          downwardAPI: {
            items: [
              {
                path: "expires-at",
                fieldRef: { fieldPath: `metadata.annotations['${ANNOTATION.expiresAt}']` },
              },
            ],
          },
        },
      ],
    },
  };
}

function service(p: LabParams): V1Service {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: LAB_POD_NAME, namespace: labNamespace(p.labId), labels: labels(p) },
    spec: {
      selector: { [LABEL.labId]: p.labId },
      ports: [{ name: "ttyd", port: TTYD_PORT, targetPort: TTYD_PORT }],
    },
  };
}

/** Route /lab/<id> to the lab. No prefix strip: ttyd runs with `-b /lab/<id>`. */
export function buildLabIngress(cfg: Config, labId: string): V1Ingress {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: {
      name: LAB_POD_NAME,
      namespace: labNamespace(labId),
      labels: { [LABEL.managedBy]: MANAGED_BY, [LABEL.labId]: labId },
    },
    spec: {
      ingressClassName: cfg.ingress.className,
      rules: [
        {
          ...(cfg.ingress.host && { host: cfg.ingress.host }),
          http: {
            paths: [
              {
                path: `/lab/${labId}`,
                pathType: "Prefix",
                backend: { service: { name: LAB_POD_NAME, port: { number: TTYD_PORT } } },
              },
            ],
          },
        },
      ],
    },
  };
}
