import type pg from "pg";
import { LOCK } from "./db.js";
import { labNamespace } from "./ids.js";

export interface LabRow {
  id: string;
  namespace: string;
  state: "ready" | "claimed";
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

const ACTIVE_FOR_OWNER = `
  SELECT * FROM labs
  WHERE owner_id = $1 AND state = 'claimed' AND deleted_at IS NULL
  ORDER BY claimed_at DESC LIMIT 1`;

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";

export function createLabStore(pool: pg.Pool) {
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
     * Reserve a cold-start slot: enforce 1 lab/user and the global cap, then
     * insert the claimed row. Runs before any Kubernetes work, so a rejected
     * request costs one DB round trip and nothing in the cluster.
     */
    async reserveColdLab(args: {
      labId: string;
      ownerId: string;
      ttlSeconds: number;
      maxLabs: number;
    }): Promise<ReserveResult> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // ponytail: one global lock serialises the count+insert so the cap can't be
        // overshot by racing requests. Fine at tens of labs; use a slots table if
        // creation throughput ever matters.
        await client.query("SELECT pg_advisory_xact_lock($1)", [LOCK.labCreate]);

        const existing = await client.query<LabRow>(ACTIVE_FOR_OWNER, [args.ownerId]);
        if (existing.rows[0]) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "existing", lab: existing.rows[0] };
        }

        // Ready (warm) and claimed labs both use node capacity.
        const { rows } = await client.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM labs WHERE deleted_at IS NULL",
        );
        if ((rows[0]?.n ?? 0) >= args.maxLabs) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "capacity" };
        }

        const inserted = await client.query<LabRow>(
          `INSERT INTO labs (id, namespace, state, owner_id, started_from, claimed_at, expires_at)
           VALUES ($1, $2, 'claimed', $3, 'cold', now(), now() + make_interval(secs => $4))
           RETURNING *`,
          [args.labId, labNamespace(args.labId), args.ownerId, args.ttlSeconds],
        );
        await client.query("COMMIT");
        return { ok: true, lab: inserted.rows[0]! };
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        // Backstop: the partial unique index caught a second active lab for this user.
        if (isUniqueViolation(err)) {
          const lab = (await pool.query<LabRow>(ACTIVE_FOR_OWNER, [args.ownerId])).rows[0];
          if (lab) return { ok: false, reason: "existing", lab };
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async markDeleted(labId: string): Promise<void> {
      await pool.query("UPDATE labs SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL", [
        labId,
      ]);
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
