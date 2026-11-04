// Runs against a real k3d cluster + Postgres. Skipped unless INTEGRATION=1.
//
//   make dev-up && make lab-image lab-image-import && make dev-db
//   make test-integration
//
// Uses your current kubeconfig context (k3d-labforge) and DATABASE_URL.
import {
  createK8s,
  createLabStore,
  createPool,
  loadConfig,
  migrate,
  type K8s,
} from "@labforge/shared";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../services/api/src/server.js";

const enabled = process.env.INTEGRATION === "1";

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

describe.skipIf(!enabled)("lab lifecycle on k3d", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let pool: pg.Pool;
  let k8s: K8s;

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://labforge:labforge@localhost:5432/labforge",
      NODE_CIDR: "172.28.0.0/16",
      ...process.env,
      NODE_ENV: "test",
      DEV_FAKE_AUTH: "true",
    });
    pool = createPool(config.databaseUrl);
    await migrate(pool);
    k8s = createK8s();
    app = await buildServer({ config, store: createLabStore(pool), k8s, logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it(
    "creates a lab whose terminal is reachable through Traefik, then deletes it",
    async () => {
      const headers = { "x-dev-user": `it-${Date.now()}` };

      const created = await app.inject({ method: "POST", url: "/api/labs", headers });
      expect(created.statusCode).toBe(201);
      const lab = created.json();
      expect(lab.ready).toBe(true);
      expect(await k8s.namespaceExists(lab.labId)).toBe(true);

      // ttyd answers on its base path via the lab's Ingress (Traefik may need a
      // moment to pick the new route up).
      const reachable = await waitFor(async () => {
        const res = await fetch(`${lab.url}/`).catch(() => null);
        return res?.status === 200;
      }, 30_000);
      expect(reachable).toBe(true);

      const deleted = await app.inject({ method: "DELETE", url: "/api/labs/me", headers });
      expect(deleted.statusCode).toBe(204);

      // Namespace deletion is asynchronous (finalizers); wait for it to be gone.
      expect(await waitFor(async () => !(await k8s.namespaceExists(lab.labId)), 120_000)).toBe(true);
    },
    240_000,
  );
});
