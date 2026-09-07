// Mirrors HealthQuest/Models/BossType.swift and the combat section of
// GameEngine.swift. Keep these in sync — same rationale as gameEngine.js.

import { RECOVERY_BUFF_DAMAGE_MULTIPLIER } from "./recoveryEngine.js";

export const BOSS_TYPES = ["golem", "windSpirit", "mirage", "balanceGuardian"];
const STAT_THRESHOLD = 40;

export function bossForWeek(weekIndex) {
  const i = ((weekIndex % BOSS_TYPES.length) + BOSS_TYPES.length) % BOSS_TYPES.length;
  return BOSS_TYPES[i];
}

export function paceMultiplier(paceMinutesPerKm) {
  if (!paceMinutesPerKm || paceMinutesPerKm <= 0) return 0.5;
  return Math.min(2.0, Math.max(0.5, 6.0 / paceMinutesPerKm));
}

export function baseDamage(distanceMeters, durationSeconds) {
  const distanceKm = (distanceMeters ?? 0) / 1000;
  if (distanceKm <= 0 || !durationSeconds || durationSeconds <= 0) return 0;
  const paceMinutesPerKm = durationSeconds / 60 / distanceKm;
  return distanceKm * paceMultiplier(paceMinutesPerKm);
}

// stats: { strength, agility, wisdom } — client-reported (see server.js
// route comment for the trust boundary this implies).
function damageMultiplier(bossType, stats) {
  const { strength = 0, agility = 0, wisdom = 0 } = stats ?? {};
  switch (bossType) {
    case "golem":
      return strength < STAT_THRESHOLD ? 0.5 : 1.0;
    case "windSpirit":
      // "Miss chance" reinterpreted as an expected-value reduction — this
      // is continuous run-derived damage, not a discrete attack roll.
      return agility < STAT_THRESHOLD ? 0.7 : 1.0;
    case "mirage":
      // Mirage never touches base damage — it attacks buffs instead, via
      // buffPotencyMultiplier below.
      return 1.0;
    case "balanceGuardian": {
      const belowCount = [strength, agility, wisdom].filter((v) => v < STAT_THRESHOLD).length;
      return Math.pow(0.5, belowCount);
    }
    default:
      return 1.0;
  }
}

// How much of a held buff's *bonus* survives this fight. Only Mirage
// touches it: failing its INT check halves the Recovery Meter bonus (e.g.
// +15% damage becomes +7.5%) rather than cutting base damage — that's what
// the design always specified, it only stood in as a flat damage penalty
// while no buff existed to weaken. Mirrors BossType.buffPotencyMultiplier.
function buffPotencyMultiplier(bossType, stats) {
  const { wisdom = 0 } = stats ?? {};
  if (bossType !== "mirage") return 1.0;
  return wisdom < STAT_THRESHOLD ? 0.5 : 1.0;
}

export function computeDamage({ distanceMeters, durationSeconds, bossType, stats, recoveryBuffActive = false }) {
  const base = baseDamage(distanceMeters, durationSeconds);
  if (base <= 0) return 0;
  // Applied as a bonus, not a flat multiplier, so a boss can weaken the
  // bonus without touching base damage.
  const rawBonus = recoveryBuffActive ? RECOVERY_BUFF_DAMAGE_MULTIPLIER - 1 : 0;
  const bonus = rawBonus * buffPotencyMultiplier(bossType, stats);
  return base * (1 + bonus) * damageMultiplier(bossType, stats);
}
