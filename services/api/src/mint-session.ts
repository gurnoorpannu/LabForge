// Admin/dev tool: create a session for a user directly in Postgres and print
// the Cookie header for it. For curl, integration tests and k6 load tests, which
// can't click through Google. Needs DATABASE_URL + SESSION_SECRET, i.e. the same
// access as the API itself, so it grants nothing an operator doesn't have.
//
//   node --env-file=services/api/.env services/api/dist/mint-session.js alice [alice@example.com]
import { createLabStore, createPool, loadConfig, migrate } from "@labforge/shared";
import { createSessionStore, sessionCookieHeader } from "./sessions.js";

const [userId, email] = process.argv.slice(2);
if (!userId) {
  console.error("usage: mint-session <user-id> [email]");
  process.exit(2);
}

const config = loadConfig();
if (!config.session.secret) {
  console.error("SESSION_SECRET is required");
  process.exit(2);
}
const secret = config.session.secret;
const pool = createPool(config.databaseUrl);
try {
  await migrate(pool);
  await createLabStore(pool).upsertUser(userId, email ?? null);
  const token = await createSessionStore(pool).create(userId, config.session.ttlSeconds);
  console.log(sessionCookieHeader(token, secret));
} finally {
  await pool.end();
}
