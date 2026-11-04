import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

// One registry per process. Phase 6 adds the gauges (labs_active, pool_ready, ...).
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

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
