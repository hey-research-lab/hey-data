-- DuckDB over a hey-data snapshot. Run from the snapshot directory:
--   duckdb < ../examples/duckdb.sql
-- Absent fields read as NULL in DuckDB: that NULL means "HEY does not know", never zero.

CREATE VIEW projects AS SELECT * FROM read_ndjson_auto('projects.ndjson');
CREATE VIEW ships    AS SELECT * FROM read_ndjson_auto('ships.ndjson');
CREATE VIEW changes  AS SELECT * FROM read_ndjson_auto('changes.ndjson');

-- How the catalogue splits by activity status (the same partitions metadata.json checks).
SELECT activityStatus, count(*) AS projects
FROM projects
GROUP BY activityStatus
ORDER BY projects DESC;

-- Projects that shipped a release in September 2026, with the newest release first.
SELECT s.project.slug AS project, s.title, s.publishedAt, s.verification, s.sourceUrl
FROM ships s
WHERE s.eventType IN ('GITHUB_RELEASE', 'APP_RELEASE')
  AND s.publishedAt >= '2026-09-01' AND s.publishedAt < '2026-10-01'
ORDER BY s.publishedAt DESC
LIMIT 20;

-- Coverage: how many projects HEY could read releases for, by state (states, never a score).
-- Read as raw JSON so the query also runs on a --no-details snapshot, which has no coverage
-- field: there every project is "not read in this snapshot", never a state of zero.
SELECT coalesce(json_extract_string(json, '$.coverage.releases.state'), 'not read in this snapshot') AS releases_state,
       count(*) AS projects
FROM read_json_objects('projects.ndjson')
GROUP BY 1
ORDER BY 2 DESC;

-- Activity-status moves recorded by the change ledger, per day HEY observed them.
SELECT CAST(detectedAt AS DATE) AS day, before, after, count(*) AS moves
FROM changes
WHERE type = 'build.status_changed'
GROUP BY ALL
ORDER BY day DESC, moves DESC
LIMIT 30;
