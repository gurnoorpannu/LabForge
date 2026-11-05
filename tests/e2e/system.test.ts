// End to end against the deployed chart, through Traefik only (like a browser).
// Skipped unless E2E=1. Needs kubectl access to mint sessions in the API pod.
//
//   make test-e2e                                   # local k3d (TTL 2m)
//   E2E=1 LABFORGE_URL=https://labs.gurnoor.online npx vitest run tests/e2e   # prod
//
// E2E_EXPIRY=0 skips the slow expiry checks (a few minutes each).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const enabled = process.env.E2E === "1";
// Not BASE_URL: Vite reserves that name and Vitest overwrites it with "/".
const BASE = (process.env.LABFORGE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const NS = process.env.LABFORGE_NAMESPACE ?? "labforge";
const expiry = process.env.E2E_EXPIRY !== "0";

const kubectl = async (...args: string[]) => (await run("kubectl", args, { timeout: 60_000 })).stdout.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(2000);
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for: ${what}`);
}

/** Session cookie for a user, minted inside the API pod (no Google needed). */
async function mint(user: string): Promise<string> {
  return (await kubectl("-n", NS, "exec", "deploy/labforge-api", "--", "node", "dist/mint-session.js", user)).split("\n").pop()!;
}

async function api(method: string, path: string, cookie?: string) {
  const res = await fetch(`${BASE}${path}`, { method, headers: cookie ? { cookie } : {}, redirect: "manual" });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, json: json as Record<string, never>, text };
}

function wsHandshake(url: string, cookie?: string): Promise<number> {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      headers: {
        Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"), "Sec-WebSocket-Protocol": "tty",
        ...(cookie ? { cookie } : {}),
      },
    });
    req.on("upgrade", (_res, socket) => (socket.destroy(), resolve(101)));
    req.on("response", (res) => (res.resume(), resolve(res.statusCode!)));
    req.on("error", reject);
    req.end();
  });
}

/** Read a metric from inside the API pod (metrics are not on the public port). */
const metric = async (name: string) => {
  const body = await kubectl("-n", NS, "exec", "deploy/labforge-api", "--", "wget", "-qO-", "http://127.0.0.1:9090/metrics");
  const line = body.split("\n").find((l) => l.startsWith(name));
  return line ? Number(line.split(" ").pop()) : NaN;
};
const nsExists = async (labId: string) =>
  (await run("kubectl", ["get", "ns", `lab-${labId}`], { timeout: 30_000 }).then(() => true, () => false));

describe.skipIf(!enabled)(`LabForge end to end (${BASE})`, () => {
  const t = Date.now();
  const who = { alice: `e2e-alice-${t}`, bob: `e2e-bob-${t}`, carol: `e2e-carol-${t}` };
  const cookie: Record<string, string> = {};

  beforeAll(async () => {
    await waitFor("API ready through Traefik", async () => (await api("GET", "/readyz")).status === 200, 120_000);
    for (const [k, id] of Object.entries(who)) cookie[k] = await mint(id);
    await waitFor("warm pool has a ready lab", async () => (await metric('labforge_pool_ready{state="ready"}')) >= 1, 180_000);
  }, 300_000);

  afterAll(async () => {
    await kubectl("-n", NS, "patch", "cronjob", "labforge-reaper", "-p", '{"spec":{"suspend":false}}').catch(() => {});
    for (const c of Object.values(cookie)) await api("DELETE", "/api/labs/me", c).catch(() => {});
  });

  it("serves the UI and refuses anonymous API calls", async () => {
    const page = await api("GET", "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect((await api("GET", "/api/labs/me")).status).toBe(401);
    expect((await api("GET", "/metrics")).status).toBe(404); // internal only
  });

  let aliceLab: { labId: string; url: string; expiresAt: string };
  it("starts a lab from the warm pool and opens it only for its owner", async () => {
    const res = await api("POST", "/api/labs", cookie.alice);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ startedFrom: "warm", ready: true });
    aliceLab = res.json as never;
    expect(aliceLab.url.startsWith(BASE)).toBe(true);

    const path = new URL(aliceLab.url).pathname;
    await waitFor("owner gets 200", async () => (await api("GET", path, cookie.alice)).status === 200, 30_000);
    expect((await api("GET", path)).status).toBe(401);
    expect((await api("GET", path, cookie.bob)).status).toBe(403);
    expect(await wsHandshake(`${aliceLab.url}ws`, cookie.alice)).toBe(101);
    expect(await wsHandshake(`${aliceLab.url}ws`, cookie.bob)).toBe(403);
  }, 60_000);

  it("an unclaimed warm lab's route is live but refuses every user (403)", async () => {
    const warm = (await kubectl("get", "ns", "-l", "labforge.io/state=ready", "-o", "jsonpath={.items[0].metadata.labels.labforge\\.io/lab-id}"));
    expect(warm).toMatch(/^[a-z0-9]{12,32}$/);
    expect((await api("GET", `/lab/${warm}/`, cookie.bob)).status).toBe(403);
    expect((await api("GET", `/lab/${warm}/`)).status).toBe(401);
    expect(await wsHandshake(`${BASE}/lab/${warm}/ws`, cookie.bob)).toBe(403);
  });

  it("refills the warm pool after a claim", async () => {
    await waitFor("pool refilled", async () => (await metric('labforge_pool_ready{state="ready"}')) >= 2, 120_000);
  }, 130_000);

  it("one lab per user: a second start returns the same lab (409)", async () => {
    const res = await api("POST", "/api/labs", cookie.alice);
    expect(res.status).toBe(409);
    expect((res.json as { lab: { labId: string } }).lab.labId).toBe(aliceLab.labId);
  });

  it.skipIf(!expiry)("expires: the reaper removes the lab within TTL + 1 minute", async () => {
    const ttlMs = new Date(aliceLab.expiresAt).getTime() - Date.now();
    await waitFor("namespace gone after expiry", async () => !(await nsExists(aliceLab.labId)), ttlMs + 90_000);
    expect(Date.now()).toBeLessThan(new Date(aliceLab.expiresAt).getTime() + 60_000 + 30_000);
    expect((await api("GET", new URL(aliceLab.url).pathname, cookie.alice)).status).not.toBe(200);
    expect(await metric("labforge_labs_reaped_total")).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it.skipIf(!expiry)("with the reaper suspended, activeDeadlineSeconds still ends the lab", async () => {
    await kubectl("-n", NS, "patch", "cronjob", "labforge-reaper", "-p", '{"spec":{"suspend":true}}');
    try {
      const res = await api("POST", "/api/labs", cookie.carol);
      expect(res.status).toBe(201);
      const lab = res.json as unknown as { labId: string; expiresAt: string };
      const deadline = new Date(lab.expiresAt).getTime() + 60_000; // expiry + grace
      await waitFor(
        "pod killed by DeadlineExceeded",
        async () => (await kubectl("-n", `lab-${lab.labId}`, "get", "pod", "lab", "-o", "jsonpath={.status.reason}")) === "DeadlineExceeded",
        deadline - Date.now() + 60_000,
      );
      // The pool controller then frees the slot (pod gone -> lab ended).
      await waitFor("namespace removed by the pool controller", async () => !(await nsExists(lab.labId)), 60_000);
      expect((await api("GET", "/api/labs/me", cookie.carol)).status).toBe(404);
    } finally {
      await kubectl("-n", NS, "patch", "cronjob", "labforge-reaper", "-p", '{"spec":{"suspend":false}}');
    }
  }, 400_000);
});
