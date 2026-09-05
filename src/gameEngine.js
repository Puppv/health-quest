// Mirrors HealthQuest/HealthKit/GameEngine.swift. Keep the two in sync —
// the client computes stats locally for instant feedback, the backend
// recomputes the same rules once events are uploaded so guild/territory
// aggregation has a single source of truth.
//
// Run/walk only (see the design pivot away from cycling/strength/yoga) —
// anything else earns 0 XP and contributes 0 game distance. HealthKit can
// still hand back other workout types; the game just doesn't score them.

const GAME_RULE_VERSION = "0.2.0";

function isRunOrWalk(event) {
  return event.activityType === "run" || event.activityType === "walk";
}

export function computeActivityResult(event) {
  const qualifies = isRunOrWalk(event);
  const xpEarned = qualifies ? Math.floor((event.distanceMeters ?? 0) / 10) : 0;
  const gameDistanceUnits = qualifies ? event.distanceMeters ?? 0 : 0;
  return {
    activityEventId: event.id,
    xpEarned,
    gameDistanceUnits,
    computedAt: new Date().toISOString(),
    gameRuleVersion: GAME_RULE_VERSION,
  };
}

export function levelForTotalXP(xp) {
  return Math.max(1, Math.floor(Math.sqrt(xp / 100)) + 1);
}
