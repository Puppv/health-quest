// Applies schema.sql then seed.sql against DATABASE_URL — run once after
// a fresh deploy (Railway/Render don't auto-run SQL files), and safe to
// re-run since every statement in both files is idempotent
// (CREATE TABLE IF NOT EXISTS, ON CONFLICT DO NOTHING, WHERE NOT EXISTS).
//
// Usage: npm run migrate   (locally, against whatever DATABASE_URL / the
// local fallback resolves to)
//        railway run npm run migrate   (against the deployed DB)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "../src/db.js";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function run() {
  const schema = readFileSync(path.join(rootDir, "schema.sql"), "utf8");
  const seed = readFileSync(path.join(rootDir, "seed.sql"), "utf8");
  await pool.query(schema);
  await pool.query(seed);
  console.log("Migration + seed applied.");
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
