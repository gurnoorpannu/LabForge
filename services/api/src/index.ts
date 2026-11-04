import { createK8s, createLabStore, createPool, loadConfig, migrate } from "@labforge/shared";
import { buildServer } from "./server.js";
import { createSessionStore } from "./sessions.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const applied = await migrate(pool);

const app = await buildServer({
  config,
  store: createLabStore(pool),
  sessions: createSessionStore(pool),
  k8s: createK8s(),
});
if (applied.length) app.log.info({ applied }, "applied migrations");
if (!config.oidc.clientId) app.log.warn("OIDC_CLIENT_ID not set: /auth/login returns 503");

await app.listen({ host: "0.0.0.0", port: config.port });

// Kubernetes sends SIGTERM on rollout; finish in-flight requests, then close the pool.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
