-- HealthQuest backend schema (PostgreSQL)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS activity_events (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    health_kit_uuid TEXT UNIQUE NOT NULL,
    source_app TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    duration_seconds INTEGER NOT NULL,
    distance_meters DOUBLE PRECISION,
    active_energy_kcal DOUBLE PRECISION,
    average_heart_rate INTEGER,
    elevation_gain_meters DOUBLE PRECISION,
    synced_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_events_user_id ON activity_events (user_id);

CREATE TABLE IF NOT EXISTS activity_results (
    activity_event_id UUID PRIMARY KEY REFERENCES activity_events (id) ON DELETE CASCADE,
    xp_earned INTEGER NOT NULL,
    game_distance_units DOUBLE PRECISION NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL,
    game_rule_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guilds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_members (
    guild_id UUID NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, user_id)
);

-- A user belongs to at most one guild in this MVP.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_members_user_id ON guild_members (user_id);

-- latitude/longitude/radius turn a cell into a real-world "Area Node" —
-- nullable because a cell can still exist as an abstract bucket (the old
-- contributeToGuild placeholder) before it has real coordinates assigned.
CREATE TABLE IF NOT EXISTS territory_cells (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    owner_guild_id UUID REFERENCES guilds (id),
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    radius_meters DOUBLE PRECISION
);

-- One row per (cell, user, day); contribution accumulates within the day
-- up to a cap enforced in application code (see guildEngine.js), and the
-- guild's weekly progress is the sum of rows within the current week.
CREATE TABLE IF NOT EXISTS territory_contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cell_id UUID NOT NULL REFERENCES territory_cells (id) ON DELETE CASCADE,
    guild_id UUID NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    day DATE NOT NULL,
    distance_meters DOUBLE PRECISION NOT NULL DEFAULT 0,
    UNIQUE (cell_id, user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_territory_contributions_cell_id ON territory_contributions (cell_id);

-- One expedition (boss fight) per guild per week, created lazily on first
-- contribution. boss_type is one of BossType.swift/bossEngine.js's 4
-- values, picked by a deterministic weekly rotation so every guild faces
-- the same boss on the same week.
CREATE TABLE IF NOT EXISTS guild_expeditions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id UUID NOT NULL REFERENCES guilds (id) ON DELETE CASCADE,
    week_start DATE NOT NULL,
    boss_type TEXT NOT NULL,
    max_hp DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (guild_id, week_start)
);

-- Raw damage log, not a mutable HP counter — same raw/computed split as
-- activity_events/activity_results, so remaining HP (max_hp - SUM(damage))
-- can always be recomputed rather than trusted as mutable state.
CREATE TABLE IF NOT EXISTS guild_expedition_damage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expedition_id UUID NOT NULL REFERENCES guild_expeditions (id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    damage DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guild_expedition_damage_expedition_id ON guild_expedition_damage (expedition_id);

-- One row per successful Area Node check-in (a route passing within the
-- cell's radius_meters). Cooldown is enforced in application code
-- (areaNodeEngine.js) by reading the user's most recent visit to a cell,
-- not by a unique constraint — a node is meant to be re-visitable after
-- the cooldown, not once-ever.
CREATE TABLE IF NOT EXISTS area_node_visits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cell_id UUID NOT NULL REFERENCES territory_cells (id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    kind TEXT NOT NULL,
    exp_reward INTEGER NOT NULL,
    visited_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_area_node_visits_cell_user ON area_node_visits (cell_id, user_id, visited_at DESC);
