import type { V1Ingress, V1Namespace, V1NetworkPolicy, V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { buildLab, EXPIRY_GRACE_SECONDS } from "./labManifest.js";

const NOW = 1_700_000_000;
const TTL = 45 * 60;
const cfg = (env: Record<string, string> = {}) =>
  loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://x", NODE_CIDR: "172.28.0.0/16", ...env });

const claimed = (env?: Record<string, string>) =>
  buildLab(cfg(env), {
    labId: "abcdefghijklmnop",
    state: "claimed",
    ownerId: "user-1",
    expiresAt: NOW + TTL,
    now: NOW,
  });

const byKind = <T>(objs: ReturnType<typeof claimed>, kind: string) =>
  objs.find((o) => o.kind === kind) as T;

describe("buildLab", () => {
  it("matches the snapshot (review diffs to this file carefully)", () => {
    expect(claimed()).toMatchSnapshot();
  });

  it("emits objects in apply order, namespace first, ingress last", () => {
    expect(claimed().map((o) => o.kind)).toEqual([
      "Namespace",
      "ResourceQuota",
      "LimitRange",
      "NetworkPolicy",
      "Pod",
      "Service",
      "Ingress",
    ]);
  });

  it("enforces the restricted Pod Security profile on the namespace", () => {
    const ns = byKind<V1Namespace>(claimed(), "Namespace");
    expect(ns.metadata?.name).toBe("lab-abcdefghijklmnop");
    expect(ns.metadata?.labels?.["pod-security.kubernetes.io/enforce"]).toBe("restricted");
    expect(ns.metadata?.annotations).toEqual({
      "labforge.io/expires-at": String(NOW + TTL),
      "labforge.io/owner": "user-1",
    });
  });

  it("hardens the pod", () => {
    const pod = byKind<V1Pod>(claimed(), "Pod");
    const spec = pod.spec!;
    const c = spec.containers[0]!;
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.enableServiceLinks).toBe(false);
    expect(spec.securityContext).toMatchObject({ runAsNonRoot: true, runAsUser: 1000 });
    expect(c.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(c.volumeMounts?.map((m) => m.mountPath)).toEqual(["/home/lab", "/tmp", "/etc/labforge"]);
    // ping via unprivileged ICMP sockets for the lab group only, not CAP_NET_RAW
    expect(spec.securityContext?.sysctls).toEqual([
      { name: "net.ipv4.ping_group_range", value: "1000 1000" },
    ]);
  });

  it("sets activeDeadlineSeconds to the remaining TTL plus grace", () => {
    const pod = byKind<V1Pod>(claimed(), "Pod");
    expect(pod.spec?.activeDeadlineSeconds).toBe(TTL + EXPIRY_GRACE_SECONDS);
  });

  it("allows ingress only from the ingress controller namespace, on 7681", () => {
    const np = byKind<V1NetworkPolicy>(claimed(), "NetworkPolicy");
    expect(np.spec?.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(np.spec?.ingress).toEqual([
      {
        _from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
        ports: [{ protocol: "TCP", port: 7681 }],
      },
    ]);
  });

  it("blocks cluster CIDRs and cloud metadata from internet egress", () => {
    const np = byKind<V1NetworkPolicy>(claimed({ NODE_CIDR: "10.0.0.0/24" }), "NetworkPolicy");
    const except = np.spec?.egress?.[1]?.to?.[0]?.ipBlock?.except;
    expect(except).toEqual(["10.42.0.0/16", "10.43.0.0/16", "10.0.0.0/24", "169.254.169.254/32"]);
  });

  it("drops the internet rule entirely when egress is disabled (DNS only)", () => {
    const np = byKind<V1NetworkPolicy>(claimed({ LAB_INTERNET_EGRESS: "false" }), "NetworkPolicy");
    expect(np.spec?.egress).toHaveLength(1);
    expect(np.spec?.egress?.[0]?.ports?.map((p) => p.port)).toEqual([53, 53]);
  });

  it("routes /lab/<id> with no host locally and the domain in prod", () => {
    const local = byKind<V1Ingress>(claimed(), "Ingress");
    expect(local.spec?.rules?.[0]?.host).toBeUndefined();
    expect(local.spec?.rules?.[0]?.http?.paths[0]?.path).toBe("/lab/abcdefghijklmnop");
    const prod = byKind<V1Ingress>(claimed({ INGRESS_HOST: "labs.gurnoor.online" }), "Ingress");
    expect(prod.spec?.rules?.[0]?.host).toBe("labs.gurnoor.online");
  });

  it("builds an unreachable warm lab: no ingress, no owner, no deadline", () => {
    const objs = buildLab(cfg(), { labId: "abcdefghijklmnop", state: "ready", now: NOW });
    expect(objs.map((o) => o.kind)).not.toContain("Ingress");
    expect(byKind<V1Namespace>(objs, "Namespace").metadata?.annotations).toEqual({});
    expect(byKind<V1Pod>(objs, "Pod").spec?.activeDeadlineSeconds).toBeUndefined();
  });

  it("refuses a claimed lab without owner and expiry", () => {
    expect(() => buildLab(cfg(), { labId: "abcdefghijklmnop", state: "claimed" })).toThrow();
  });
});
