import { createServer, type Server } from "node:http";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { LabStats } from "./labStore.js";

// One registry per process.
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

/**
 * /metrics (and /healthz) on their own port. Kept off the public HTTP port so
 * the Ingress, which routes "/" to the API, can never expose them.
 */
export function startMetricsServer(port: number): Server {
  return createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("content-type", registry.contentType);
      return res.end(await registry.metrics());
    }
    res.statusCode = req.url === "/healthz" ? 200 : 404;
    res.end();
  }).listen(port, "0.0.0.0");
}

/**
 * Metrics read from Postgres at scrape time (lab counts, reaper heartbeat).
 * Registered only by the process that calls this (the API): if every process
 * registered them, the pool controller would export unset gauges as 0, and
 * e.g. ReaperStale (time() - last_success) would misfire. All API replicas
 * report the same DB truth, so alert on max(), not sum().
 */
export interface DbMetricsSource {
  stats(): Promise<LabStats>;
  getHeartbeat(name: string): Promise<{ lastSuccess: Date; total: number } | null>;
}
let dbSource: DbMetricsSource | undefined;
let dbMetricsRegistered = false;
export function setDbMetricsSource(source: DbMetricsSource) {
  dbSource = source;
  if (dbMetricsRegistered) return; // tests build several servers per process
  dbMetricsRegistered = true;

  new Gauge({
    name: "labforge_labs_active",
    help: "Labs currently claimed by a user (not yet deleted).",
    registers: [registry],
    async collect() {
      this.set((await dbSource!.stats()).claimed);
    },
  });
  new Gauge({
    name: "labforge_pool_ready",
    help: "Warm labs in the pool, by state.",
    labelNames: ["state"] as const, // ready | warming
    registers: [registry],
    async collect() {
      const s = await dbSource!.stats();
      this.set({ state: "ready" }, s.ready);
      this.set({ state: "warming" }, s.warming);
    },
  });
  new Gauge({
    name: "labforge_reaper_last_success_timestamp_seconds",
    help: "Unix time of the reaper's last successful run (from its DB heartbeat).",
    registers: [registry],
    async collect() {
      const hb = await dbSource!.getHeartbeat("reaper");
      // Never succeeded: stays 0, so time() - value is huge and ReaperStale fires.
      if (hb) this.set(hb.lastSuccess.getTime() / 1000);
    },
  });
  new Counter({
    name: "labforge_labs_reaped_total",
    help: "Expired labs deleted by the reaper, all time (from its DB heartbeat).",
    registers: [registry],
    async collect() {
      const hb = await dbSource!.getHeartbeat("reaper");
      // The count lives in Postgres (the reaper is a short-lived Job), so mirror it.
      this.reset();
      if (hb) this.inc(hb.total);
    },
  });
}

export const labStartDuration = new Histogram({
  name: "labforge_lab_start_duration_seconds",
  help: "Time from start request to the lab pod being Ready.",
  labelNames: ["started_from"] as const,
  buckets: [0.25, 0.5, 1, 2, 3, 5, 8, 13, 20, 30, 60],
  registers: [registry],
});

// Runs on every terminal HTTP request (page, assets, websocket upgrade), so it
// gets fine-grained low buckets.
export const authVerifyDuration = new Histogram({
  name: "labforge_auth_verify_duration_seconds",
  help: "Latency of /auth/verify (Traefik ForwardAuth) by outcome.",
  labelNames: ["result"] as const, // allowed | unauthenticated | forbidden
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry],
});

export const labRequests = new Counter({
  name: "labforge_lab_requests_total",
  help: "Lab start requests by outcome.",
  labelNames: ["result"] as const, // created | rejected_capacity | rejected_existing | error
  registers: [registry],
});
