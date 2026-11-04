import fastifyCookie from "@fastify/cookie";
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

export const SESSION_COOKIE = "lf_session";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface SessionUser {
  id: string;
  email: string | null;
}

export function createSessionStore(pool: pg.Pool) {
  return {
    /** Returns the raw token; only its hash is stored. */
    async create(userId: string, ttlSeconds: number): Promise<string> {
      const token = randomBytes(32).toString("base64url");
      await pool.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3))`,
        [hashToken(token), userId, ttlSeconds],
      );
      return token;
    },

    async resolve(token: string): Promise<SessionUser | null> {
      const { rows } = await pool.query<SessionUser>(
        `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [hashToken(token)],
      );
      return rows[0] ?? null;
    },

    async destroy(token: string): Promise<void> {
      await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    },

    /**
     * ForwardAuth's question in one indexed round trip: is this a live session,
     * and does its user own this lab right now (claimed, not deleted, not expired)?
     */
    async checkLabAccess(token: string, labId: string): Promise<{ userId: string | null; owns: boolean }> {
      const { rows } = await pool.query<{ user_id: string; owns: boolean }>(
        `SELECT s.user_id,
                EXISTS (SELECT 1 FROM labs l
                        WHERE l.id = $2 AND l.owner_id = s.user_id AND l.state = 'claimed'
                          AND l.deleted_at IS NULL AND l.expires_at > now()) AS owns
         FROM sessions s
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [hashToken(token), labId],
      );
      const row = rows[0];
      return row ? { userId: row.user_id, owns: row.owns } : { userId: null, owns: false };
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/**
 * `Cookie` header value for a session token, signed exactly as the server signs
 * it. Used by the mint-session CLI and the integration tests.
 */
export function sessionCookieHeader(token: string, secret: string): string {
  const signed = fastifyCookie.signerFactory(secret).sign(token);
  return `${SESSION_COOKIE}=${encodeURIComponent(signed)}`;
}
