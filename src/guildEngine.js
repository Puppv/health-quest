import { pool } from "./db.js";

// Placeholder balancing numbers until real GPS-based cell attribution
// exists (see the exploration/guild design notes) — tune freely.
const DAILY_CAP_METERS = 5000;
const WEEKLY_TARGET_METERS = 30000;

// Thailand has no DST, so a fixed +7h offset is safe here — no timezone
// database needed. Weekly reset uses Bangkok-local Monday 00:00, not UTC
// Monday 00:00, so a Monday-morning run in Thailand doesn't fall into the
// previous week's rollup.
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

export function currentWeekStart(date = new Date()) {
  const bangkokNow = new Date(date.getTime() + BANGKOK_OFFSET_MS);
  const bangkokMidnight = new Date(
    Date.UTC(bangkokNow.getUTCFullYear(), bangkokNow.getUTCMonth(), bangkokNow.getUTCDate())
  );
  const day = bangkokMidnight.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  bangkokMidnight.setUTCDate(bangkokMidnight.getUTCDate() - diffToMonday);
  return new Date(bangkokMidnight.getTime() - BANGKOK_OFFSET_MS);
}

export async function getUserGuildId(userId) {
  const res = await pool.query(`SELECT guild_id FROM guild_members WHERE user_id = $1`, [userId]);
  return res.rows[0]?.guild_id ?? null;
}

export async function listGuilds() {
  const res = await pool.query(
    `SELECT g.id, g.name, COUNT(gm.user_id)::int AS member_count
     FROM guilds g
     LEFT JOIN guild_members gm ON gm.guild_id = g.id
     GROUP BY g.id, g.name
     ORDER BY g.name`
  );
  return res.rows.map((row) => ({
    id: row.id,
    name: row.name,
    memberCount: row.member_count,
  }));
}

// A user belongs to at most one guild — joining a new one leaves whatever
// guild they were in first. No cooldown yet (see design doc's open
// fairness questions).
export async function joinGuild(guildId, userId) {
  await pool.query(`DELETE FROM guild_members WHERE user_id = $1`, [userId]);
  await pool.query(`INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2)`, [guildId, userId]);
}

export async function createGuild(name, userId) {
  const guildRes = await pool.query(`INSERT INTO guilds (name) VALUES ($1) RETURNING id, name`, [name]);
  const guild = guildRes.rows[0];
  await joinGuild(guild.id, userId);
  return { id: guild.id, name: guild.name };
}

// Shared by both attribution paths below: insert/cap the day's
// contribution row for a specific cell, then flip ownership if the week's
// total has crossed the target.
async function insertContribution(cellId, guildId, userId, distanceMeters) {
  const weekStart = currentWeekStart();
  const today = new Date();

  await pool.query(
    `INSERT INTO territory_contributions (cell_id, guild_id, user_id, day, distance_meters)
     VALUES ($1, $2, $3, $4, LEAST($5::double precision, $6::double precision))
     ON CONFLICT (cell_id, user_id, day) DO UPDATE SET
       distance_meters = LEAST(territory_contributions.distance_meters + $5::double precision, $6::double precision)`,
    [cellId, guildId, userId, today, distanceMeters, DAILY_CAP_METERS]
  );

  const totalRes = await pool.query(
    `SELECT COALESCE(SUM(distance_meters), 0) AS total
     FROM territory_contributions
     WHERE cell_id = $1 AND day >= $2`,
    [cellId, weekStart]
  );
  if (Number(totalRes.rows[0].total) >= WEEKLY_TARGET_METERS) {
    await pool.query(`UPDATE territory_cells SET owner_guild_id = $1 WHERE id = $2`, [guildId, cellId]);
  }
}

// Fills whichever of the guild's not-yet-owned cells has the lowest
// progress this week — spreads contributions evenly without needing real
// geography. Distance is capped per user/cell/day so one person can't
// solo-claim a cell in a single day. No-ops for a user with no guild —
// guild membership is no longer auto-created (see createGuild/joinGuild).
//
// This is the pre-Area-Node placeholder path: it still runs for any run/
// walk distance, so a cell can be contested even by players who never pass
// near one of the seeded coordinates (see contributeToCell for the
// geography-aware path).
export async function contributeToGuild(userId, distanceMeters) {
  if (!distanceMeters || distanceMeters <= 0) return;
  const guildId = await getUserGuildId(userId);
  if (!guildId) return;

  const weekStart = currentWeekStart();
  const cellsRes = await pool.query(
    `SELECT tc.id, COALESCE(SUM(contrib.distance_meters), 0) AS weekly_total
     FROM territory_cells tc
     LEFT JOIN territory_contributions contrib
       ON contrib.cell_id = tc.id AND contrib.day >= $1
     WHERE tc.owner_guild_id IS NULL OR tc.owner_guild_id != $2
     GROUP BY tc.id
     ORDER BY weekly_total ASC
     LIMIT 1`,
    [weekStart, guildId]
  );
  if (cellsRes.rows.length === 0) return;
  await insertContribution(cellsRes.rows[0].id, guildId, userId, distanceMeters);
}

// Geography-aware path used by an Area Node check-in (see
// areaNodeEngine.js) — targets the specific cell the player physically
// passed through instead of picking the least-progressed one. Returns null
// (no-op) for a user with no guild, same as contributeToGuild.
export async function contributeToCell(userId, cellId, distanceMeters) {
  if (!distanceMeters || distanceMeters <= 0) return null;
  const guildId = await getUserGuildId(userId);
  if (!guildId) return null;
  await insertContribution(cellId, guildId, userId, distanceMeters);
  return guildId;
}

// Returns null if the user isn't in a guild yet — callers show a
// create/join picker instead of silently enrolling them anywhere.
export async function getGuildForUser(userId) {
  const guildId = await getUserGuildId(userId);
  if (!guildId) return null;

  const weekStart = currentWeekStart();

  const guildRes = await pool.query(`SELECT id, name FROM guilds WHERE id = $1`, [guildId]);
  const guild = guildRes.rows[0];

  const memberCountRes = await pool.query(
    `SELECT COUNT(*)::int AS count FROM guild_members WHERE guild_id = $1`,
    [guildId]
  );

  const cellsRes = await pool.query(
    `SELECT tc.id, tc.name, tc.owner_guild_id, og.name AS owner_guild_name,
            COALESCE(SUM(contrib.distance_meters) FILTER (WHERE contrib.day >= $1), 0) AS weekly_total
     FROM territory_cells tc
     LEFT JOIN guilds og ON og.id = tc.owner_guild_id
     LEFT JOIN territory_contributions contrib ON contrib.cell_id = tc.id
     GROUP BY tc.id, tc.name, tc.owner_guild_id, og.name
     ORDER BY tc.name`,
    [weekStart]
  );

  return {
    guildId: guild.id,
    guildName: guild.name,
    memberCount: memberCountRes.rows[0].count,
    cells: cellsRes.rows.map((row) => ({
      id: row.id,
      name: row.name,
      ownerGuildId: row.owner_guild_id,
      ownerGuildName: row.owner_guild_name,
      progressPercent: Math.min(1, Number(row.weekly_total) / WEEKLY_TARGET_METERS),
    })),
  };
}
