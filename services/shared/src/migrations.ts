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
  {
    id: "002_sessions",
    sql: `
      -- The cookie carries a random token; only its SHA-256 is stored, so a
      -- database leak does not hand out live sessions.
      CREATE TABLE sessions (
        token_hash  TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at  TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX sessions_expires_at ON sessions (expires_at);
    `,
  },
  {
    id: "003_warm_pool",
    sql: `
      -- 'warming': row exists (counts toward the cap) while the pod starts;
      -- the pool controller flips it to 'ready' once the pod is Ready. Only
      -- 'ready' labs can be claimed.
      ALTER TABLE labs DROP CONSTRAINT labs_state_check;
      ALTER TABLE labs ADD CONSTRAINT labs_state_check
        CHECK (state IN ('warming', 'ready', 'claimed'));
      ALTER TABLE labs DROP CONSTRAINT labs_check;
      ALTER TABLE labs ADD CONSTRAINT labs_claimed_has_owner
        CHECK (state <> 'claimed' OR (owner_id IS NOT NULL AND expires_at IS NOT NULL));

      -- Liveness of jobs that run briefly (the reaper CronJob): the API turns
      -- these rows into Prometheus metrics. See docs/adr/0005.
      CREATE TABLE heartbeats (
        name          TEXT PRIMARY KEY,
        last_success  TIMESTAMPTZ NOT NULL,
        total         BIGINT NOT NULL DEFAULT 0  -- e.g. labs reaped, all time
      );
    `,
  },
];
