import { KubeConfig } from "@kubernetes/client-node";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { createK8s } from "./k8s.js";
import { buildLab } from "./labManifest.js";

// Kinds the fake API server advertises through discovery.
const RESOURCES: Record<string, Array<{ name: string; kind: string; namespaced: boolean }>> = {
  "/api/v1": [
    { name: "namespaces", kind: "Namespace", namespaced: false },
    { name: "resourcequotas", kind: "ResourceQuota", namespaced: true },
    { name: "limitranges", kind: "LimitRange", namespaced: true },
    { name: "pods", kind: "Pod", namespaced: true },
    { name: "services", kind: "Service", namespaced: true },
  ],
  "/apis/networking.k8s.io/v1": [
    { name: "networkpolicies", kind: "NetworkPolicy", namespaced: true },
    { name: "ingresses", kind: "Ingress", namespaced: true },
  ],
  "/apis/traefik.io/v1alpha1": [{ name: "middlewares", kind: "Middleware", namespaced: true }],
};

/**
 * The client renames some fields in its TS models (`from` -> `_from`,
 * `default` -> `_default`). If those leaked onto the wire, the API server would
 * silently drop them, and a NetworkPolicy ingress rule with no `from` allows
 * traffic from everywhere. So assert on the real HTTP request bodies.
 */
describe("createK8s against a fake API server", () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  let server: Server;
  let kc: KubeConfig;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        const discovery = RESOURCES[req.url ?? ""];
        if (req.method === "GET" && discovery) {
          const groupVersion = req.url!.replace(/^\/apis?\//, "");
          const resources = discovery.map((r) => ({ ...r, singularName: "", verbs: ["create"] }));
          return res.end(JSON.stringify({ kind: "APIResourceList", groupVersion, resources }));
        }
        if (req.method === "POST") {
          posts.push({ url: req.url!, body: JSON.parse(raw) });
          res.statusCode = 201;
          return res.end(raw);
        }
        if (req.method === "DELETE") {
          res.statusCode = 404;
          return res.end(JSON.stringify({ kind: "Status", code: 404, reason: "NotFound" }));
        }
        res.statusCode = 500;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    kc = new KubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: "fake", server: `http://127.0.0.1:${port}`, skipTLSVerify: true }],
      users: [{ name: "fake" }],
      contexts: [{ name: "fake", cluster: "fake", user: "fake" }],
      currentContext: "fake",
    });

    const cfg = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgres://x", NODE_CIDR: "172.28.0.0/16", SESSION_SECRET: "x".repeat(32) });
    const objs = buildLab(cfg, {
      labId: "abcdefghijklmnop",
      state: "claimed",
      ownerId: "u1",
      expiresAt: 2_000_000_000,
      now: 1_999_997_300,
    });
    await createK8s(kc).applyLab(objs);
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const bodyFor = (resource: string) => posts.find((p) => p.url.endsWith(`/${resource}`))!.body;

  it("creates the namespace first, then the namespaced objects inside it", () => {
    expect(posts[0]?.url).toBe("/api/v1/namespaces");
    expect(posts.slice(1).every((p) => p.url.includes("/namespaces/lab-abcdefghijklmnop/"))).toBe(true);
    expect(posts).toHaveLength(8);
  });

  it("creates the Traefik Middleware (a CRD the client has no model for) before the Ingress", () => {
    const urls = posts.map((p) => p.url);
    const mw = urls.findIndex((u) => u.startsWith("/apis/traefik.io/v1alpha1/") && u.endsWith("/middlewares"));
    const ing = urls.findIndex((u) => u.endsWith("/ingresses"));
    expect(mw).toBeGreaterThan(-1);
    expect(mw).toBeLessThan(ing);
    const body = bodyFor("middlewares") as { spec: { forwardAuth: { address: string } } };
    expect(body.spec.forwardAuth.address).toContain("?lab=abcdefghijklmnop");
  });

  it("sends NetworkPolicy ingress as `from`, never `_from`", () => {
    const rule = (bodyFor("networkpolicies") as { spec: { ingress: Array<Record<string, unknown>> } })
      .spec.ingress[0]!;
    expect(rule).toHaveProperty("from");
    expect(rule).not.toHaveProperty("_from");
  });

  it("sends LimitRange defaults as `default`, never `_default`", () => {
    const limit = (bodyFor("limitranges") as { spec: { limits: Array<Record<string, unknown>> } })
      .spec.limits[0]!;
    expect(limit).toHaveProperty("default");
    expect(limit).not.toHaveProperty("_default");
  });

  it("treats deleting an already-gone lab as success", async () => {
    await expect(createK8s(kc).deleteLab("abcdefghijklmnop")).resolves.toBeUndefined();
  });
});
