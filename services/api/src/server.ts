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
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

export interface User {
  id: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface Deps {
  config: Config;
  store: LabStore;
  k8s: K8s;
  /** false silences request logs in tests. */
  logger?: boolean;
}

const devUserHeader = z.string().regex(/^[A-Za-z0-9._@-]{1,64}$/);

export async function buildServer({ config, store, k8s, logger = true }: Deps) {
  const app = Fastify({
    logger: logger && { level: config.logLevel },
    trustProxy: true, // behind Traefik: req.ip comes from X-Forwarded-For
  });

  app.decorateRequest("user", null);

  // Resolve who is calling; never rejects. Routes that need a user use requireUser.
  // Runs before the per-route rate limiter, so limits are keyed per user.
  app.addHook("onRequest", async (req) => {
    if (config.devFakeAuth) {
      const parsed = devUserHeader.safeParse(req.headers["x-dev-user"]);
      if (parsed.success) req.user = { id: parsed.data };
    }
    // Phase 3: otherwise resolve the session cookie.
  });

  await app.register(rateLimit, { global: false });

  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) return reply.code(401).send({ error: "unauthenticated" });
  };

  const toDto = (lab: LabRow) => ({
    labId: lab.id,
    url: `${config.publicBaseUrl}/lab/${lab.id}`,
    expiresAt: lab.expires_at?.toISOString() ?? null,
    startedFrom: lab.started_from,
  });

  // --- health ---------------------------------------------------------------

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_req, reply) => {
    const [db, kube] = await Promise.allSettled([store.ping(), k8s.ping()]);
    const checks = { db: db.status === "fulfilled", k8s: kube.status === "fulfilled" };
    return reply.code(checks.db && checks.k8s ? 200 : 503).send({ checks });
  });

  app.get("/metrics", async (_req, reply) =>
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
      await store.upsertUser(user.id, null);

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
