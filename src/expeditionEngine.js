import { pool } from "./db.js";
import { currentWeekStart, getUserGuildId } from "./guildEngine.js";
import { bossForWeek, computeDamage } from "./bossEngine.js";

// HP scales with guild size (200km / 4 members from the design doc, i.e.
// 50 "km-equivalent" damage per member) so small and large guilds face a
// comparably challenging fight.
const HP_PER_MEMBER = 50;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function weekIndexFor(weekStart) {
  return Math.floor(weekStart.getTime() / WEEK_MS);
}

async function getOrCreateExpedition(guildId) {
  const weekStart = currentWeekStart();
  const existing = await pool.query(
    `SELECT id, guild_id, week_start, boss_type, max_hp FROM guild_expeditions
     WHERE guild_id = $1 AND week_start = $2`,
    [guildId, weekStart]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const memberCountRes = await pool.query(`SELECT COUNT(*)::int AS count FROM guild_members WHERE guild_id = $1`, [
    guildId,
  ]);
  const memberCount = Math.max(1, memberCountRes.rows[0].count);
  const bossType = bossForWeek(weekIndexFor(weekStart));
  const maxHp = HP_PER_MEMBER * memberCount;

  const inserted = await pool.query(
    `INSERT INTO guild_expeditions (guild_id, week_start, boss_type, max_hp)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (guild_id, week_start) DO UPDATE SET guild_id = EXCLUDED.guild_id
     RETURNING id, guild_id, week_start, boss_type, max_hp`,
    [guildId, weekStart, bossType, maxHp]
  );
  return inserted.rows[0];
}

async function expeditionStatus(expedition) {
  const damageRes = await pool.query(
    `SELECT COALESCE(SUM(damage), 0) AS total FROM guild_expedition_damage WHERE expedition_id = $1`,
    [expedition.id]
  );
  const totalDamage = Number(damageRes.rows[0].total);
  return {
    bossType: expedition.boss_type,
    maxHp: Number(expedition.max_hp),
    totalDamage,
    remainingHp: Math.max(0, Number(expedition.max_hp) - totalDamage),
    defeated: totalDamage >= Number(expedition.max_hp),
  };
}

export async function getExpeditionForGuild(guildId) {
  const expedition = await getOrCreateExpedition(guildId);
  return expeditionStatus(expedition);
}

// Returns null if the user isn't in a guild — callers should treat that as
// "nothing to contribute to" rather than an error (mirrors
// contributeToGuild's no-op for guildless users).
export async function contributeToExpedition(userId, { distanceMeters, durationSeconds, stats, recoveryBuffActive = false }) {
  const guildId = await getUserGuildId(userId);
  if (!guildId) return null;

  const expedition = await getOrCreateExpedition(guildId);
  const damage = computeDamage({
    distanceMeters,
    durationSeconds,
    bossType: expedition.boss_type,
    stats,
    recoveryBuffActive,
  });
  if (damage > 0) {
    await pool.query(
      `INSERT INTO guild_expedition_damage (expedition_id, user_id, damage) VALUES ($1, $2, $3)`,
      [expedition.id, userId, damage]
    );
  }
  return { damageDealt: damage, ...(await expeditionStatus(expedition)) };
}
