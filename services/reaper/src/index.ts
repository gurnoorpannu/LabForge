// @labforge/reaper: one-shot job (Kubernetes CronJob, every minute,
// concurrencyPolicy Forbid). Deletes expired labs. Exit code 1 if anything
// failed, so the Job shows as failed and kube-state-metrics can alert on it.
import { createK8s, createLabStore, createPool, loadConfig } from "@labforge/shared";
import pino from "pino";
import { reap } from "./reap.js";

const config = loadConfig();
const log = pino({ level: config.logLevel, base: { service: "reaper" } });
const pool = createPool(config.databaseUrl);

const result = await reap(createK8s(), async () => {
  await pool.query("SELECT 1"); // fail fast if Postgres is down
  return createLabStore(pool);
});
await pool.end().catch(() => {});

if (result.reaped.length || result.failed.length) log.info({ reaped: result.reaped, failed: result.failed }, "reaped");
if (result.dbError) log.error({ err: result.dbError }, "namespaces handled, but DB bookkeeping failed");
process.exit(result.failed.length || result.dbError ? 1 : 0);
