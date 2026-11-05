// Real Postgres, no Kubernetes. Skipped unless INTEGRATION=1.
// Proves the cold-start reservation rules hold under concurrent requests: the
// unit tests only exercise an in-memory fake of this logic.
import { createLabStore, createPool, migrate, newLabId, type LabStore } from "@labforge/shared";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.INTEGRATION === "1";

describe.skipIf(!enabled)("reserveLab under concurrency (Postgres)", () => {
  let pool: pg.Pool;
  let store: LabStore;
  const run = `conc-${Date.now()}`;

  beforeAll(async () => {
    pool = createPool(
      process.env.DATABASE_URL ?? "postgres://labforge:labforge@localhost:5432/labforge",
    );
    await migrate(pool);
    store = createLabStore(pool);
    // Start from an empty slate so the global cap counts only this test's rows.
    await pool.query("UPDATE labs SET deleted_at = now() WHERE deleted_at IS NULL");
  });

  afterAll(async () => {
    await pool.query("UPDATE labs SET deleted_at = now() WHERE owner_id LIKE $1", [`${run}%`]);
    await pool.end();
  });

  const reserve = async (ownerId: string, maxLabs: number) => {
    await store.upsertUser(ownerId, null);
    return store.reserveLab({ newLabId: newLabId(), ownerId, ttlSeconds: 60, maxLabs });
  };

  it("gives one user exactly one lab out of 20 simultaneous requests", async () => {
    const user = `${run}-same`;
    const results = await Promise.all(Array.from({ length: 20 }, () => reserve(user, 100)));
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "existing")).toHaveLength(19);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM labs WHERE owner_id = $1 AND deleted_at IS NULL",
      [user],
    );
    expect(rows[0].n).toBe(1);
  });

  it("never exceeds the global cap: 20 users racing for 3 remaining slots", async () => {
    // The previous test left 1 active lab; cap 4 leaves 3 slots.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => reserve(`${run}-u${i}`, 4)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.reason === "capacity")).toHaveLength(17);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM labs WHERE deleted_at IS NULL");
    expect(rows[0].n).toBe(4);
  });

  it("20 parallel starts for 3 warm labs: exactly 3 are served warm, none twice", async () => {
    await pool.query("UPDATE labs SET deleted_at = now() WHERE deleted_at IS NULL");
    const warm = [newLabId(), newLabId(), newLabId()];
    for (const id of warm) {
      await pool.query("INSERT INTO labs (id, namespace, state) VALUES ($1, $2, 'ready')", [id, `lab-${id}`]);
    }
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => reserve(`${run}-w${i}`, 100)),
    );
    const ok = results.flatMap((r) => (r.ok ? [r.lab] : []));
    expect(ok).toHaveLength(20);
    const fromPool = ok.filter((l) => l.started_from === "warm");
    expect(fromPool.map((l) => l.id).sort()).toEqual([...warm].sort()); // each warm lab exactly once
    expect(ok.filter((l) => l.started_from === "cold")).toHaveLength(17);
    expect(new Set(ok.map((l) => l.id)).size).toBe(20); // no lab handed to two users
    expect(new Set(ok.map((l) => l.owner_id)).size).toBe(20);
  });

  it("enforces one active lab per user in the database itself (partial unique index)", async () => {
    const user = `${run}-idx`;
    await store.upsertUser(user, null);
    const insert = () =>
      pool.query(
        `INSERT INTO labs (id, namespace, state, owner_id, started_from, claimed_at, expires_at)
         VALUES ($1, $2, 'claimed', $3, 'cold', now(), now() + interval '1 minute')`,
        [newLabId(), `lab-${newLabId()}`, user],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" }); // unique_violation
  });
});
