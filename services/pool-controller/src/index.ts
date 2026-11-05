// @labforge/pool-controller: keeps POOL_SIZE warm labs ready and fixes drift
// between Postgres and the cluster. Run 2 replicas; a Postgres advisory lock
// makes exactly one of them the leader, the other waits as a hot standby.
import { createK8s, createLabStore, createPool, loadConfig, LOCK, migrate, registry, startMetricsServer } from "@labforge/shared";
import pg from "pg";
import pino from "pino";
import { Counter, Gauge, Histogram } from "prom-client";
import { isNoop, reconcile } from "./reconcile.js";

const config = loadConfig();
const log = pino({ level: config.logLevel, base: { service: "pool-controller" } });
const pool = createPool(config.databaseUrl);
await migrate(pool);
const store = createLabStore(pool);
const k8s = createK8s();

const leaderGauge = new Gauge({
  name: "labforge_pool_controller_leader",
  help: "1 if this replica holds the pool-controller leader lock.",
  registers: [registry],
});
const reconcileDuration = new Histogram({
  name: "labforge_pool_reconcile_duration_seconds",
  help: "Duration of one reconcile pass.",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});
const reconcileErrors = new Counter({
  name: "labforge_pool_reconcile_errors_total",
  help: "Reconcile passes that threw.",
  registers: [registry],
});

// /metrics for Prometheus, /healthz for the liveness probe.
startMetricsServer(config.metricsPort);

// Session-level advisory locks belong to one connection, so the leader lock gets
// a dedicated client. If that connection drops, Postgres releases the lock; we
// exit and let Kubernetes restart us rather than reconcile without it.
const lockClient = new pg.Client({ connectionString: config.databaseUrl, keepAlive: true });
lockClient.on("error", (err) => {
  log.error({ err }, "leader-lock connection lost, exiting");
  process.exit(1);
});
await lockClient.connect();

let leader = false;
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    stopping = true;
    log.info({ signal }, "shutting down");
  });
}

log.info({ poolSize: config.lab.poolSize, max: config.lab.maxConcurrent }, "pool controller started");
while (!stopping) {
  if (!leader) {
    const { rows } = await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [
      LOCK.poolLeader,
    ]);
    if (rows[0]?.ok) {
      leader = true;
      log.info("acquired leadership");
    }
  }
  leaderGauge.set(leader ? 1 : 0);

  if (leader) {
    const end = reconcileDuration.startTimer();
    try {
      const result = await reconcile({ cfg: config, store, k8s });
      if (!isNoop(result)) log.info(result, "reconciled");
    } catch (err) {
      reconcileErrors.inc();
      log.error({ err }, "reconcile failed");
    } finally {
      end();
    }
  }
  await new Promise((r) => setTimeout(r, config.lab.reconcileIntervalSeconds * 1000));
}

await lockClient.end(); // releases the lock so the standby takes over at once
await pool.end();
process.exit(0);
