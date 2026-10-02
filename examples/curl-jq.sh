#!/usr/bin/env bash
# jq over a hey-data snapshot, and curl for the same public routes hey-data reads.
#   bash examples/curl-jq.sh snapshot
set -euo pipefail
dir="${1:-snapshot}"

# Snapshot facts.
jq '{generatedAt, chainId, source, license, attribution, recordCount}' "$dir/metadata.json"

# Projects by activity status.
jq -r '.activityStatus' "$dir/projects.ndjson" | sort | uniq -c | sort -rn

# Releases with their source, newest detected first (the file's order).
jq -r 'select(.eventType == "GITHUB_RELEASE") | [.project.slug, .title, .publishedAt, .sourceUrl] | @tsv' \
  "$dir/ships.ndjson" | head -n 10

# Coverage gaps: projects whose releases dimension is not MEASURED, with the reason HEY gives.
jq -r 'select(.coverage.releases.state != null and .coverage.releases.state != "MEASURED")
       | [.slug, .coverage.releases.state, (.coverage.releases.reason // "")] | @tsv' \
  "$dir/projects.ndjson" | head -n 10

# The live API, keyless. Quote every URL; pause between calls (the anonymous limit is 120/min).
curl -fsS "https://heyresearch.xyz/api/projects?status=SHIPPING&limit=3" | jq '{total, slugs: [.items[].slug]}'
sleep 1
curl -fsS "https://heyresearch.xyz/api/changes?after=c1.0&limit=3" | jq '.items[] | {id, type, summary}'
