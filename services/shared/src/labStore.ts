import type pg from "pg";
import { LOCK } from "./db.js";
import { labNamespace } from "./ids.js";

export type LabRowState = "warming" | "ready" | "claimed";

export interface LabRow {
  id: string;
  namespace: string;
  state: LabRowState;
  owner_id: string | null;
  started_from: "warm" | "cold" | null;
  created_at: Date;
  claimed_at: Date | null;
  expires_at: Date | null;
  deleted_at: Date | null;
}

export type ReserveResult =
  | { ok: true; lab: LabRow }
  | { ok: false; reason: "existing"; lab: LabRow }
  | { ok: false; reason: "capacity" };

export interface LabStats {
  warming: number;
  ready: number;
  claimed: number;
}

const ACTIVE_FOR_OWNER = `
  SELECT * FROM labs
  WHERE owner_id = $1 AND state = 'claimed' AND deleted_at IS NULL
  ORDER BY claimed_at DESC LIMIT 1`;

// Every row not yet deleted holds (or is about to hold) node capacity.
const LIVE_COUNT = "SELECT count(*)::int AS n FROM labs WHERE deleted_at IS NULL";

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";

export function createLabStore(pool: pg.Pool) {
  /** Run fn in a transaction holding the lab-creation lock (see reserveLab). */
  async function withCreateLock<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // ponytail: one global lock serialises count+insert/claim, so the cap can't
      // be overshot by racing API replicas and the pool controller. Held for a few
      // ms; use a slots table if creation throughput ever matters.
      await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK.labCreate]);
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    async ping(): Promise<void> {
      await pool.query("SELECT 1");
    },

    async upsertUser(id: string, email: string | null): Promise<void> {
      await pool.query(
        `INSERT INTO users (id, email) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET email = COALESCE(EXCLUDED.email, users.email)`,
        [id, email],
      );
    },

    /** Current lab for a user. An expired lab still counts until the reaper deletes it. */
    async getActiveLab(ownerId: string): Promise<LabRow | null> {
      const { rows } = await pool.query<LabRow>(ACTIVE_FOR_OWNER, [ownerId]);
      return rows[0] ?? null;
    },

    /**
     * Give a user a lab: enforce 1 lab/user, then claim the oldest warm lab
     * atomically, else reserve a cold slot if the global cap allows. Runs before
     * any Kubernetes work, so a rejected request costs one DB round trip.
     */
    async reserveLab(args: {
      newLabId: string; // used only for a cold start
      ownerId: string;
      ttlSeconds: number;
      maxLabs: number;
    }): Promise<ReserveResult> {
      try {
        return await withCreateLock(async (c) => {
          const existing = (await c.query<LabRow>(ACTIVE_FOR_OWNER, [args.ownerId])).rows[0];
          if (existing) return { ok: false, reason: "existing", lab: existing };

          // Warm claim. SKIP LOCKED: a row another transaction holds (e.g. the pool
          // controller recycling it) is skipped, not waited on. Moving ready ->
          // claimed doesn't change the live count, so no cap check is needed.
          const warm = (
            await c.query<LabRow>(
              `UPDATE labs
               SET state = 'claimed', owner_id = $1, claimed_at = now(),
                   expires_at = now() + make_interval(secs => $2), started_from = 'warm'
               WHERE id = (SELECT id FROM labs
                           WHERE state = 'ready' AND deleted_at IS NULL
                           ORDER BY created_at
                           FOR UPDATE SKIP LOCKED LIMIT 1)
               RETURNING *`,
              [args.ownerId, args.ttlSeconds],
            )
          ).rows[0];
          if (warm) return { ok: true, lab: warm };

          const live = (await c.query<{ n: number }>(LIVE_COUNT)).rows[0]?.n ?? 0;
          if (live >= args.maxLabs) return { ok: false, reason: "capacity" };

          const cold = (
            await c.query<LabRow>(
              `INSERT INTO labs (id, namespace, state, owner_id, started_from, claimed_at, expires_at)
               VALUES ($1, $2, 'claimed', $3, 'cold', now(), now() + make_interval(secs => $4))
               RETURNING *`,
              [args.newLabId, labNamespace(args.newLabId), args.ownerId, args.ttlSeconds],
            )
          ).rows[0]!;
          return { ok: true, lab: cold };
        });
      } catch (err) {
        // Backstop: the partial unique index caught a second active lab for this user.
        if (isUniqueViolation(err)) {
          const lab = (await pool.query<LabRow>(ACTIVE_FOR_OWNER, [args.ownerId])).rows[0];
          if (lab) return { ok: false, reason: "existing", lab };
        }
        throw err;
      }
    },

    async markDeleted(labIds: string | string[]): Promise<number> {
      const ids = Array.isArray(labIds) ? labIds : [labIds];
      if (ids.length === 0) return 0;
      const res = await pool.query(
        "UPDATE labs SET deleted_at = now() WHERE id = ANY($1) AND deleted_at IS NULL",
        [ids],
      );
      return res.rowCount ?? 0;
    },

    // --- pool controller -----------------------------------------------------------

    async liveLabs(): Promise<LabRow[]> {
      return (await pool.query<LabRow>("SELECT * FROM labs WHERE deleted_at IS NULL")).rows;
    },

    /** Insert a warming row if the cap allows. False = no room. */
    async insertWarming(labId: string, maxLabs: number): Promise<boolean> {
      return withCreateLock(async (c) => {
        const live = (await c.query<{ n: number }>(LIVE_COUNT)).rows[0]?.n ?? 0;
        if (live >= maxLabs) return false;
        await c.query("INSERT INTO labs (id, namespace, state) VALUES ($1, $2, 'warming')", [
          labId,
          labNamespace(labId),
        ]);
        return true;
      });
    },

    async markReady(labId: string): Promise<void> {
      await pool.query(
        "UPDATE labs SET state = 'ready' WHERE id = $1 AND state = 'warming' AND deleted_at IS NULL",
        [labId],
      );
    },

    /**
     * Retire an unclaimed lab. Only succeeds while it is still unclaimed, so it
     * can never race a user's claim: whichever UPDATE commits first wins.
     */
    async retireUnclaimed(labId: string): Promise<boolean> {
      const res = await pool.query(
        `UPDATE labs SET deleted_at = now()
         WHERE id = $1 AND state IN ('warming', 'ready') AND deleted_at IS NULL`,
        [labId],
      );
      return (res.rowCount ?? 0) > 0;
    },

    // --- reaper + metrics ---------------------------------------------------------

    async heartbeat(name: string, increment = 0): Promise<void> {
      await pool.query(
        `INSERT INTO heartbeats (name, last_success, total) VALUES ($1, now(), $2)
         ON CONFLICT (name) DO UPDATE
           SET last_success = now(), total = heartbeats.total + EXCLUDED.total`,
        [name, increment],
      );
    },

    async getHeartbeat(name: string): Promise<{ lastSuccess: Date; total: number } | null> {
      const { rows } = await pool.query<{ last_success: Date; total: string }>(
        "SELECT last_success, total FROM heartbeats WHERE name = $1",
        [name],
      );
      return rows[0] ? { lastSuccess: rows[0].last_success, total: Number(rows[0].total) } : null;
    },

    async deleteExpiredSessions(): Promise<number> {
      return (await pool.query("DELETE FROM sessions WHERE expires_at < now()")).rowCount ?? 0;
    },

    async stats(): Promise<LabStats> {
      const { rows } = await pool.query<{ state: LabRowState; n: number }>(
        "SELECT state, count(*)::int AS n FROM labs WHERE deleted_at IS NULL GROUP BY state",
      );
      const s: LabStats = { warming: 0, ready: 0, claimed: 0 };
      for (const r of rows) s[r.state] = r.n;
      return s;
    },

    async audit(
      actor: string | null,
      action: string,
      labId: string | null,
      detail?: Record<string, unknown>,
    ): Promise<void> {
      await pool.query(
        "INSERT INTO audit_log (actor, action, lab_id, detail) VALUES ($1, $2, $3, $4)",
        [actor, action, labId, detail ?? null],
      );
    },
  };
}

export type LabStore = ReturnType<typeof createLabStore>;
