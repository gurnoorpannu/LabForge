import fastifyCookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import {
  buildLab,
  labRequests,
  labStartDuration,
  newLabId,
  registry,
  type Config,
  type K8s,
  type LabRow,
  type LabStore,
} from "@labforge/shared";
import Fastify, { type FastifyRequest } from "fastify";
import { registerAuth, requireUser } from "./auth.js";
import type { SessionStore } from "./sessions.js";
import { APP_JS, CSP, INDEX_HTML } from "./ui.js";

export interface Deps {
  config: Config;
  store: LabStore;
  sessions: SessionStore;
  k8s: K8s;
  /** false silences request logs in tests. */
  logger?: boolean;
}

export async function buildServer({ config, store, sessions, k8s, logger = true }: Deps) {
  const app = Fastify({
    logger: logger && { level: config.logLevel },
    trustProxy: true, // behind Traefik: req.ip comes from X-Forwarded-For
  });

  await app.register(fastifyCookie, { secret: config.session.secret });
  await registerAuth(app, { config, sessions, store });
  await app.register(rateLimit, { global: false });

  const toDto = (lab: LabRow) => ({
    labId: lab.id,
    url: `${config.publicBaseUrl}/lab/${lab.id}/`,
    expiresAt: lab.expires_at?.toISOString() ?? null,
    startedFrom: lab.started_from,
  });

  // --- UI -------------------------------------------------------------------

  app.get("/", { config: { skipSession: true } }, async (_req, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .header("content-security-policy", CSP)
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .send(INDEX_HTML),
  );
  app.get("/app.js", { config: { skipSession: true } }, async (_req, reply) =>
    reply.type("text/javascript; charset=utf-8").header("x-content-type-options", "nosniff").send(APP_JS),
  );

  // --- health ---------------------------------------------------------------

  app.get("/healthz", { config: { skipSession: true } }, async () => ({ status: "ok" }));

  app.get("/readyz", { config: { skipSession: true } }, async (_req, reply) => {
    const [db, kube] = await Promise.allSettled([store.ping(), k8s.ping()]);
    const checks = { db: db.status === "fulfilled", k8s: kube.status === "fulfilled" };
    return reply.code(checks.db && checks.k8s ? 200 : 503).send({ checks });
  });

  app.get("/metrics", { config: { skipSession: true } }, async (_req, reply) =>
    reply.header("content-type", registry.contentType).send(await registry.metrics()),
  );

  // --- labs -----------------------------------------------------------------

  app.post(
    "/api/labs",
    {
      preHandler: requireUser,
      config: {
        rateLimit: {
          max: config.rateLimitPerMin,
          timeWindow: "1 minute",
          keyGenerator: (req: FastifyRequest) => req.user?.id ?? req.ip,
        },
      },
    },
    async (req, reply) => {
      const user = req.user!;
      const stopTimer = labStartDuration.startTimer({ started_from: "cold" });

      const labId = newLabId();
      const reserved = await store.reserveColdLab({
        labId,
        ownerId: user.id,
        ttlSeconds: config.lab.ttlSeconds,
        maxLabs: config.lab.maxConcurrent,
      });

      if (!reserved.ok && reserved.reason === "existing") {
        labRequests.inc({ result: "rejected_existing" });
        return reply.code(409).send({ error: "lab_exists", lab: toDto(reserved.lab) });
      }
      if (!reserved.ok) {
        labRequests.inc({ result: "rejected_capacity" });
        return reply
          .code(503)
          .header("retry-after", "60")
          .send({ error: "at_capacity", message: "All lab slots are in use. Try again shortly." });
      }

      const lab = reserved.lab;
      try {
        const expiresAt = Math.floor(lab.expires_at!.getTime() / 1000);
        await k8s.applyLab(
          buildLab(config, { labId, state: "claimed", ownerId: user.id, expiresAt }),
        );
        const ready = await k8s.waitForPodReady(labId, config.lab.readyTimeoutSeconds * 1000);
        if (ready) stopTimer();
        labRequests.inc({ result: "created" });
        await store.audit(user.id, "lab.create", labId, { startedFrom: "cold", ready });
        return reply.code(201).send({ ...toDto(lab), ready });
      } catch (err) {
        labRequests.inc({ result: "error" });
        req.log.error({ err, labId }, "lab create failed, rolling back");
        await k8s.deleteLab(labId).catch((e) => req.log.warn({ err: e, labId }, "rollback delete failed"));
        await store.markDeleted(labId);
        return reply.code(500).send({ error: "lab_create_failed" });
      }
    },
  );

  app.get("/api/labs/me", { preHandler: requireUser }, async (req, reply) => {
    const lab = await store.getActiveLab(req.user!.id);
    if (!lab) return reply.code(404).send({ error: "no_lab" });
    return toDto(lab);
  });

  app.delete("/api/labs/me", { preHandler: requireUser }, async (req, reply) => {
    const lab = await store.getActiveLab(req.user!.id);
    if (!lab) return reply.code(404).send({ error: "no_lab" });
    await k8s.deleteLab(lab.id);
    await store.markDeleted(lab.id);
    await store.audit(req.user!.id, "lab.delete", lab.id);
    return reply.code(204).send();
  });

  return app;
}
