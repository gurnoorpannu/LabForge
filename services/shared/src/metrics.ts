import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { LabStats } from "./labStore.js";

// One registry per process.
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

/**
 * Where the DB-derived metrics come from. The API sets it; every scrape then
 * reads current lab counts and the reaper heartbeat from Postgres, so all API
 * replicas report the same truth (alert on max(), not sum()).
 */
export interface DbMetricsSource {
  stats(): Promise<LabStats>;
  getHeartbeat(name: string): Promise<{ lastSuccess: Date; total: number } | null>;
}
let dbSource: DbMetricsSource | undefined;
export function setDbMetricsSource(source: DbMetricsSource) {
  dbSource = source;
}

export const labsActive = new Gauge({
  name: "labforge_labs_active",
  help: "Labs currently claimed by a user (not yet deleted).",
  registers: [registry],
  async collect() {
    if (dbSource) this.set((await dbSource.stats()).claimed);
  },
});

export const poolReady = new Gauge({
  name: "labforge_pool_ready",
  help: "Warm labs ready to be claimed.",
  labelNames: ["state"] as const, // ready | warming
  registers: [registry],
  async collect() {
    if (!dbSource) return;
    const s = await dbSource.stats();
    this.set({ state: "ready" }, s.ready);
    this.set({ state: "warming" }, s.warming);
  },
});

export const reaperLastSuccess = new Gauge({
  name: "labforge_reaper_last_success_timestamp_seconds",
  help: "Unix time of the reaper's last successful run (from its DB heartbeat).",
  registers: [registry],
  async collect() {
    const hb = await dbSource?.getHeartbeat("reaper");
    if (hb) this.set(hb.lastSuccess.getTime() / 1000);
  },
});

export const labsReaped = new Counter({
  name: "labforge_labs_reaped_total",
  help: "Expired labs deleted by the reaper, all time (from its DB heartbeat).",
  registers: [registry],
  async collect() {
    const hb = await dbSource?.getHeartbeat("reaper");
    if (hb) {
      // The count lives in Postgres (the reaper is a short-lived Job), so mirror it.
      this.reset();
      this.inc(hb.total);
    }
  },
});

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
