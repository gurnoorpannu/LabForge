// Shared fixtures for the API unit tests: in-memory stores with the same rules
// as the SQL (the SQL itself runs against real Postgres in tests/integration).
import { loadConfig, type K8s, type LabRow, type LabStore } from "@labforge/shared";
import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { buildServer } from "./server.js";
import { sessionCookieHeader, type SessionStore } from "./sessions.js";

export const SECRET = "s".repeat(32);

export function memoryBackend() {
  const labs: LabRow[] = [];
  const users = new Map<string, string | null>();
  const sessions = new Map<string, { userId: string; expires: number }>();
  const active = (owner: string) =>
    labs.find((l) => l.owner_id === owner && l.state === "claimed" && !l.deleted_at) ?? null;
  const live = (token: string) => {
    const s = sessions.get(token);
    return s && s.expires > Date.now() ? s : null;
  };

  const store: LabStore = {
    ping: async () => {},
    upsertUser: async (id, email) => void users.set(id, email),
    audit: async () => {},
    getActiveLab: async (owner) => active(owner),
    markDeleted: async (id) => {
      const lab = labs.find((l) => l.id === id);
      if (lab && !lab.deleted_at) lab.deleted_at = new Date();
    },
    reserveColdLab: async ({ labId, ownerId, ttlSeconds, maxLabs }) => {
      const existing = active(ownerId);
      if (existing) return { ok: false, reason: "existing", lab: existing };
      if (labs.filter((l) => !l.deleted_at).length >= maxLabs) return { ok: false, reason: "capacity" };
      const now = new Date();
      const lab: LabRow = {
        id: labId,
        namespace: `lab-${labId}`,
        state: "claimed",
        owner_id: ownerId,
        started_from: "cold",
        created_at: now,
        claimed_at: now,
        expires_at: new Date(now.getTime() + ttlSeconds * 1000),
        deleted_at: null,
      };
      labs.push(lab);
      return { ok: true, lab };
    },
  };

  const sessionStore: SessionStore = {
    create: async (userId, ttl) => {
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, { userId, expires: Date.now() + ttl * 1000 });
      return token;
    },
    resolve: async (token) => {
      const s = live(token);
      return s ? { id: s.userId, email: users.get(s.userId) ?? null } : null;
    },
    destroy: async (token) => void sessions.delete(token),
    checkLabAccess: async (token, labId) => {
      const s = live(token);
      if (!s) return { userId: null, owns: false };
      const owns = labs.some(
        (l) =>
          l.id === labId &&
          l.owner_id === s.userId &&
          l.state === "claimed" &&
          !l.deleted_at &&
          l.expires_at!.getTime() > Date.now(),
      );
      return { userId: s.userId, owns };
    },
  };

  return { store, sessions: sessionStore, labs };
}

export function fakeK8s(): K8s & { [K in keyof K8s]: ReturnType<typeof vi.fn> } {
  return {
    applyLab: vi.fn(async () => {}),
    deleteLab: vi.fn(async () => {}),
    namespaceExists: vi.fn(async () => true),
    waitForPodReady: vi.fn(async () => true),
    ping: vi.fn(async () => {}),
  };
}

export async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://x",
    NODE_CIDR: "172.28.0.0/16",
    SESSION_SECRET: SECRET,
    PUBLIC_BASE_URL: "https://labs.example.test",
    ...env,
  });
  const k8s = fakeK8s();
  const backend = memoryBackend();
  const app = await buildServer({ config, ...backend, k8s, logger: false });
  /** Headers for a logged-in user (session created the way /auth/callback does). */
  const as = async (user: string) => {
    await backend.store.upsertUser(user, `${user}@example.test`);
    const token = await backend.sessions.create(user, 3600);
    return { cookie: sessionCookieHeader(token, SECRET) };
  };
  return { app, k8s, as, backend };
}
