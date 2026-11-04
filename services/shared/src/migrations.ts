// Forward-only SQL migrations, applied in order and recorded in schema_migrations.
// Never edit an applied migration: add a new one.
export const MIGRATIONS: ReadonlyArray<{ id: string; sql: string }> = [
  {
    id: "001_init",
    sql: `
      CREATE TABLE users (
        id          TEXT PRIMARY KEY,              -- OIDC "sub" (dev: x-dev-user)
        email       TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Source of truth for lab assignment (who owns which namespace).
      CREATE TABLE labs (
        id            TEXT PRIMARY KEY,
        namespace     TEXT NOT NULL UNIQUE,
        state         TEXT NOT NULL CHECK (state IN ('ready', 'claimed')),
        owner_id      TEXT REFERENCES users(id),
        started_from  TEXT CHECK (started_from IN ('warm', 'cold')),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        claimed_at    TIMESTAMPTZ,
        expires_at    TIMESTAMPTZ,
        deleted_at    TIMESTAMPTZ,
        CHECK (state = 'ready' OR (owner_id IS NOT NULL AND expires_at IS NOT NULL))
      );

      -- "1 active lab per user", enforced by the database even under concurrent requests.
      CREATE UNIQUE INDEX labs_one_active_per_owner
        ON labs (owner_id) WHERE state = 'claimed' AND deleted_at IS NULL;

      -- Warm-pool claim scans the oldest ready lab (Phase 5).
      CREATE INDEX labs_ready_by_age
        ON labs (created_at) WHERE state = 'ready' AND deleted_at IS NULL;

      CREATE TABLE audit_log (
        id      BIGSERIAL PRIMARY KEY,
        at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        actor   TEXT,
        action  TEXT NOT NULL,
        lab_id  TEXT,
        detail  JSONB
      );
    `,
  },
];
