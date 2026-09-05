// Mirrors the Recovery Meter logic in GameEngine.swift
// (recoveryMeterTimeline / isRecoveryBuffActive) — the client computes this
// locally for instant display, the backend recomputes it independently from
// the same uploaded events so Guild Expedition damage (a shared, visible
// number) isn't just trusting whatever buff flag the client claims.

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const RECOVERY_CAP = 100;
const RECOVERY_DECAY_PER_DAY = 10;
const RECOVERY_WINDOW_DAYS = 14;
// Ship-first value per the design doc — not finalized, expect to tune from
// real playtest data like the class multipliers.
export const RECOVERY_BUFF_DAMAGE_MULTIPLIER = 1.15;

function startOfBangkokDay(date) {
  const bangkokNow = new Date(date.getTime() + BANGKOK_OFFSET_MS);
  const bangkokMidnight = new Date(
    Date.UTC(bangkokNow.getUTCFullYear(), bangkokNow.getUTCMonth(), bangkokNow.getUTCDate())
  );
  return new Date(bangkokMidnight.getTime() - BANGKOK_OFFSET_MS);
}

/// Simulates the meter day-by-day over the trailing window: +1 point per
/// minute walked that day (capped at 100), or −10 on any day with zero walk
/// minutes. Stateless recompute from the uploaded event window, same as
/// STR/AGI/INT — not a persisted accumulator. Returns a Map keyed by each
/// day's ISO timestamp (start of that Bangkok day).
export function recoveryMeterTimeline(events, referenceDate = new Date()) {
  const walkMinutesByDay = new Map();
  for (const event of events) {
    if (event.activityType !== "walk") continue;
    const key = startOfBangkokDay(new Date(event.startDate)).toISOString();
    const minutes = Math.floor((event.durationSeconds ?? 0) / 60);
    walkMinutesByDay.set(key, (walkMinutesByDay.get(key) ?? 0) + minutes);
  }

  const today = startOfBangkokDay(referenceDate);
  const startDay = new Date(today.getTime() - (RECOVERY_WINDOW_DAYS - 1) * DAY_MS);

  const timeline = new Map();
  let meter = 0;
  for (let day = startDay; day <= today; day = new Date(day.getTime() + DAY_MS)) {
    const key = day.toISOString();
    const minutes = walkMinutesByDay.get(key) ?? 0;
    meter = minutes > 0 ? Math.min(RECOVERY_CAP, meter + minutes) : Math.max(0, meter - RECOVERY_DECAY_PER_DAY);
    timeline.set(key, meter);
  }
  return timeline;
}

/// A run gets the buff if the meter was at cap on its own day or the day
/// before — an approximation of "reached full within 48h" using the same
/// day-bucketed timeline rather than exact timestamps.
export function isRecoveryBuffActive(event, timeline) {
  const day = startOfBangkokDay(new Date(event.startDate));
  const dayBefore = new Date(day.getTime() - DAY_MS);
  const meterToday = timeline.get(day.toISOString()) ?? 0;
  const meterYesterday = timeline.get(dayBefore.toISOString()) ?? 0;
  return meterToday >= RECOVERY_CAP || meterYesterday >= RECOVERY_CAP;
}

export function currentRecoveryMeter(events, referenceDate = new Date()) {
  const timeline = recoveryMeterTimeline(events, referenceDate);
  const key = startOfBangkokDay(referenceDate).toISOString();
  return timeline.get(key) ?? 0;
}
