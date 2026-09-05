-- Seeds the default guild and starter territory cells referenced by
-- guildEngine.js's auto-enroll behavior. Safe to re-run.

INSERT INTO guilds (name)
VALUES ('Dawn Striders')
ON CONFLICT (name) DO NOTHING;

-- Real Bangkok coordinates — this is the manual seed pipeline referenced in
-- the design doc as the stand-in for a future OpenStreetMap import; radius
-- 75m sits in the middle of the decided 50-100m check-in range.
INSERT INTO territory_cells (name, latitude, longitude, radius_meters)
SELECT name, latitude, longitude, radius_meters FROM (VALUES
    ('สวนลุมพินี', 13.7307, 100.5418, 75.0),
    ('สวนเบญจกิติ', 13.7229, 100.5602, 75.0),
    ('คลองผดุงกรุงเกษม', 13.7466, 100.5153, 75.0)
) AS seed(name, latitude, longitude, radius_meters)
WHERE NOT EXISTS (SELECT 1 FROM territory_cells WHERE territory_cells.name = seed.name);

-- Backfill coordinates for cells that already exist in a running DB from
-- before this migration (INSERT above no-ops for them via the name match).
UPDATE territory_cells SET latitude = 13.7307, longitude = 100.5418, radius_meters = 75.0
    WHERE name = 'สวนลุมพินี' AND latitude IS NULL;
UPDATE territory_cells SET latitude = 13.7229, longitude = 100.5602, radius_meters = 75.0
    WHERE name = 'สวนเบญจกิติ' AND latitude IS NULL;
UPDATE territory_cells SET latitude = 13.7466, longitude = 100.5153, radius_meters = 75.0
    WHERE name = 'คลองผดุงกรุงเกษม' AND latitude IS NULL;
