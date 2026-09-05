import pg from "pg";

const { Pool } = pg;

// Railway/Render both inject DATABASE_URL and require SSL on their managed
// Postgres; local dev never sets it (falls back to the local instance
// below), so "DATABASE_URL is set" is a reliable enough signal for "we're
// deployed" without needing a separate NODE_ENV flag. rejectUnauthorized
// is off because these platforms use certs not chained to a public CA —
// acceptable for a friends-and-family-scale hobby deploy, revisit if this
// ever needs to defend against MITM on the DB connection specifically.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://localhost:5433/healthquest",
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

export const db = {
  async upsertActivityEvent(event, result) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // `xmax = 0` is a standard Postgres idiom for "this row came from the
      // INSERT branch, not the ON CONFLICT UPDATE branch" — xmax is only
      // ever set by an UPDATE/DELETE. Callers use this to avoid re-running
      // side effects (like guild contribution) on a resynced duplicate.
      const eventRes = await client.query(
        `INSERT INTO activity_events (
           id, user_id, health_kit_uuid, source_app, activity_type,
           start_date, end_date, duration_seconds, distance_meters,
           active_energy_kcal, average_heart_rate, elevation_gain_meters, synced_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (health_kit_uuid) DO UPDATE SET synced_at = EXCLUDED.synced_at
         RETURNING *, (xmax = 0) AS inserted`,
        [
          event.id,
          event.userId,
          event.healthKitUUID,
          event.sourceApp,
          event.activityType,
          event.startDate,
          event.endDate,
          event.durationSeconds,
          event.distanceMeters ?? null,
          event.activeEnergyKcal ?? null,
          event.averageHeartRate ?? null,
          event.elevationGainMeters ?? null,
          event.syncedAt,
        ]
      );
      const storedEvent = eventRes.rows[0];

      await client.query(
        `INSERT INTO activity_results (
           activity_event_id, xp_earned, game_distance_units, computed_at, game_rule_version
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (activity_event_id) DO UPDATE SET
           xp_earned = EXCLUDED.xp_earned,
           game_distance_units = EXCLUDED.game_distance_units,
           computed_at = EXCLUDED.computed_at,
           game_rule_version = EXCLUDED.game_rule_version`,
        [storedEvent.id, result.xpEarned, result.gameDistanceUnits, result.computedAt, result.gameRuleVersion]
      );

      await client.query("COMMIT");
      return { ...storedEvent, isNew: storedEvent.inserted };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  },

  async getResultsForUser(userId) {
    const res = await pool.query(
      `SELECT ar.xp_earned, ar.game_distance_units
       FROM activity_results ar
       JOIN activity_events ae ON ae.id = ar.activity_event_id
       WHERE ae.user_id = $1`,
      [userId]
    );
    return res.rows.map((r) => ({
      xpEarned: r.xp_earned,
      gameDistanceUnits: Number(r.game_distance_units),
    }));
  },

  async getActivityCountForUser(userId) {
    const res = await pool.query(`SELECT COUNT(*)::int AS count FROM activity_events WHERE user_id = $1`, [userId]);
    return res.rows[0].count;
  },
};
