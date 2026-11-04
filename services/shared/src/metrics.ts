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

export const labRequests = new Counter({
  name: "labforge_lab_requests_total",
  help: "Lab start requests by outcome.",
  labelNames: ["result"] as const, // created | rejected_capacity | rejected_existing | error
  registers: [registry],
});
