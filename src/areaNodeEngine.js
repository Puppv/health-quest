// Area Node — the shared-coordinate merge of the old personal-RNG route
// encounters and the abstract territory_cells placeholder (see the design
// doc's exploration section). A territory_cells row with lat/lng/radius
// set is both an encounter spot everyone can see and a specific cell a
// guild can contest, rather than two separate systems.
//
// Coordinates here come from a manual seed (seed.sql) standing in for the
// OpenStreetMap import pipeline the design doc still leaves open — see
// listAreaNodes.

import { pool } from "./db.js";
import { contributeToCell } from "./guildEngine.js";
import { DeterministicHash } from "./deterministicHash.js";

// Ship-first values, same "tune from real data" posture as the class
// multipliers and Recovery Meter buff.
const VISIT_COOLDOWN_HOURS = 24;
// A check-in is a discrete event, not a continuous GPS distance — this
// stands in for "how much territory progress one check-in is worth",
// deliberately smaller than the 5,000m/day solo cap so a node alone can't
// replace normal distance-based contribution.
const CHECKIN_CONTRIBUTION_METERS = 500;

const KIND_REWARDS = { treasure: 20, lore: 10, rareLoot: 50 };

function pickKind(seed) {
  const roll = DeterministicHash.fnv1a(seed) % 100n;
  if (roll < 50n) return "treasure";
  if (roll < 85n) return "lore";
  return "rareLoot";
}

export async function listAreaNodes() {
  const res = await pool.query(
    `SELECT id, name, latitude, longitude, radius_meters
     FROM territory_cells
     WHERE latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY name`
  );
  return res.rows.map((row) => ({
    id: row.id,
    name: row.name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radiusMeters: Number(row.radius_meters),
  }));
}

// Returns { onCooldown: true, cooldownUntil } if this user checked into
// this cell within the last VISIT_COOLDOWN_HOURS, otherwise records the
// visit, contributes to the cell's territory progress, and returns
// { kind, expReward }. Callers (server.js) should treat onCooldown as a
// 409, not an error.
export async function visitAreaNode(userId, cellId) {
  const cellRes = await pool.query(
    `SELECT id FROM territory_cells WHERE id = $1 AND latitude IS NOT NULL`,
    [cellId]
  );
  if (cellRes.rows.length === 0) return { notFound: true };

  const lastVisitRes = await pool.query(
    `SELECT visited_at FROM area_node_visits
     WHERE cell_id = $1 AND user_id = $2
     ORDER BY visited_at DESC LIMIT 1`,
    [cellId, userId]
  );
  const cooldownMs = VISIT_COOLDOWN_HOURS * 60 * 60 * 1000;
  if (lastVisitRes.rows.length > 0) {
    const lastVisitAt = new Date(lastVisitRes.rows[0].visited_at);
    const cooldownUntil = new Date(lastVisitAt.getTime() + cooldownMs);
    if (cooldownUntil > new Date()) {
      return { onCooldown: true, cooldownUntil: cooldownUntil.toISOString() };
    }
  }

  // Seeded by cell + user + today's date so retrying the same day (e.g. the
  // client re-syncing its rolling window) can't reroll a better kind.
  const dayKey = new Date().toISOString().slice(0, 10);
  const kind = pickKind(`${cellId}-${userId}-${dayKey}`);
  const expReward = KIND_REWARDS[kind];

  await pool.query(
    `INSERT INTO area_node_visits (cell_id, user_id, kind, exp_reward) VALUES ($1, $2, $3, $4)`,
    [cellId, userId, kind, expReward]
  );
  await contributeToCell(userId, cellId, CHECKIN_CONTRIBUTION_METERS);

  return { kind, expReward };
}
