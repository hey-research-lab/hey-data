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
SELECT coverage.releases.state AS releases_state, count(*) AS projects
FROM projects
WHERE coverage IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC;

-- Activity-status moves recorded by the change ledger, per day HEY observed them.
SELECT CAST(detectedAt AS DATE) AS day, before, after, count(*) AS moves
FROM changes
WHERE type = 'build.status_changed'
GROUP BY ALL
ORDER BY day DESC, moves DESC
LIMIT 30;
