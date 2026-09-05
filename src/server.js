import express from "express";
import { db } from "./db.js";
import { computeActivityResult, levelForTotalXP } from "./gameEngine.js";
import { contributeToGuild, createGuild, getGuildForUser, joinGuild, listGuilds } from "./guildEngine.js";
import { contributeToExpedition, getExpeditionForGuild } from "./expeditionEngine.js";
import { recoveryMeterTimeline, isRecoveryBuffActive } from "./recoveryEngine.js";
import { listAreaNodes, visitAreaNode } from "./areaNodeEngine.js";

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/activity-events", async (req, res, next) => {
  try {
    const event = req.body;
    if (!event?.healthKitUUID || !event?.userId) {
      return res.status(400).json({ error: "healthKitUUID and userId are required" });
    }
    const result = computeActivityResult(event);
    const stored = await db.upsertActivityEvent(event, result);
    if (stored.isNew) {
      await contributeToGuild(event.userId, result.gameDistanceUnits);
    }
    res.status(201).json({ event: stored, result });
  } catch (err) {
    next(err);
  }
});

// Body is { events, stats? } rather than a bare array so newly-inserted
// run events can be fed to the guild expedition using the caller's
// current stats — gated on isNew, same as contributeToGuild, so
// re-syncing an already-synced run (e.g. the app re-fetching its rolling
// 14-day HealthKit window on every launch) never deals expedition damage
// twice for the same real-world run.
app.post("/api/activity-events/batch", async (req, res, next) => {
  try {
    const { events, stats } = Array.isArray(req.body) ? { events: req.body, stats: null } : req.body ?? {};
    if (!Array.isArray(events)) {
      return res.status(400).json({ error: "expected { events: ActivityEvent[], stats? }" });
    }
    // Recomputed independently from the same events the client uploaded —
    // same trust model as the rest of computeActivityResult, but keeps the
    // Recovery Meter buff from being a bare boolean the client could just
    // assert (see recoveryEngine.js).
    const recoveryTimeline = recoveryMeterTimeline(events);
    const stored = [];
    for (const event of events) {
      const result = computeActivityResult(event);
      const storedEvent = await db.upsertActivityEvent(event, result);
      stored.push(storedEvent);
      if (storedEvent.isNew) {
        await contributeToGuild(event.userId, result.gameDistanceUnits);
        if (event.activityType === "run" && stats) {
          await contributeToExpedition(event.userId, {
            distanceMeters: event.distanceMeters,
            durationSeconds: event.durationSeconds,
            stats,
            recoveryBuffActive: isRecoveryBuffActive(event, recoveryTimeline),
          });
        }
      }
    }
    res.status(201).json({ count: stored.length });
  } catch (err) {
    next(err);
  }
});

app.get("/api/character/:userId", async (req, res, next) => {
  try {
    const { userId } = req.params;
    const results = await db.getResultsForUser(userId);
    const totalXP = results.reduce((sum, r) => sum + r.xpEarned, 0);
    const totalGameDistanceUnits = results.reduce((sum, r) => sum + r.gameDistanceUnits, 0);
    res.json({
      userId,
      totalXP,
      level: levelForTotalXP(totalXP),
      totalGameDistanceUnits,
      activityCount: results.length,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/users/:userId/guild", async (req, res, next) => {
  try {
    const summary = await getGuildForUser(req.params.userId);
    if (!summary) {
      return res.status(404).json({ error: "not in a guild" });
    }
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

app.get("/api/guilds", async (req, res, next) => {
  try {
    const guilds = await listGuilds();
    res.json({ guilds });
  } catch (err) {
    next(err);
  }
});

app.post("/api/guilds", async (req, res, next) => {
  try {
    const { name, userId } = req.body ?? {};
    if (!name?.trim() || !userId) {
      return res.status(400).json({ error: "name and userId are required" });
    }
    const guild = await createGuild(name.trim(), userId);
    res.status(201).json(guild);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "guild name already taken" });
    }
    next(err);
  }
});

app.post("/api/guilds/:guildId/join", async (req, res, next) => {
  try {
    const { userId } = req.body ?? {};
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }
    await joinGuild(req.params.guildId, userId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

app.get("/api/guilds/:guildId/expedition", async (req, res, next) => {
  try {
    const status = await getExpeditionForGuild(req.params.guildId);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// stats (strength/agility/wisdom) are client-computed and trusted as-is —
// same trust boundary as the rest of this app's XP: HealthKit-derived data
// is deduped and rate-limited (see db.js/guildEngine.js) but not
// cryptographically verified. Revisit if this becomes worth cheating on.
app.post("/api/guilds/expedition/contribute", async (req, res, next) => {
  try {
    const { userId, distanceMeters, durationSeconds, strength, agility, wisdom, recoveryBuffActive } = req.body ?? {};
    if (!userId || !distanceMeters || !durationSeconds) {
      return res.status(400).json({ error: "userId, distanceMeters, and durationSeconds are required" });
    }
    const result = await contributeToExpedition(userId, {
      distanceMeters,
      durationSeconds,
      stats: { strength: strength ?? 0, agility: agility ?? 0, wisdom: wisdom ?? 0 },
      recoveryBuffActive: Boolean(recoveryBuffActive),
    });
    if (!result) {
      return res.status(404).json({ error: "not in a guild" });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get("/api/area-nodes", async (req, res, next) => {
  try {
    const nodes = await listAreaNodes();
    res.json({ nodes });
  } catch (err) {
    next(err);
  }
});

// Visiting is a check-in (client detected a GPS point within the node's
// radius), not a distance report — see areaNodeEngine.js for the
// cooldown/reward logic and how it feeds into territory contribution.
app.post("/api/area-nodes/:cellId/visit", async (req, res, next) => {
  try {
    const { userId } = req.body ?? {};
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }
    const result = await visitAreaNode(userId, req.params.cellId);
    if (result.notFound) {
      return res.status(404).json({ error: "area node not found" });
    }
    if (result.onCooldown) {
      return res.status(409).json({ error: "on cooldown", cooldownUntil: result.cooldownUntil });
    }
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message ?? "internal error" });
});

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => {
  console.log(`HealthQuest backend listening on http://localhost:${PORT}`);
});
