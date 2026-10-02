"""Read a hey-data snapshot with pandas and DuckDB.

    pip install pandas duckdb
    python examples/pandas_duckdb.py snapshot

An absent field is NaN/None in pandas: it means HEY does not know it. Do not
fill it with 0.
"""

import json
import sys
from pathlib import Path

import duckdb
import pandas as pd

root = Path(sys.argv[1] if len(sys.argv) > 1 else "snapshot")
meta = json.loads((root / "metadata.json").read_text())
print(f"snapshot generated {meta['generatedAt']} from {meta['source']} (chain {meta['chainId']})")
print(f"licence {meta['license']}: {meta['attribution']}")

projects = pd.read_json(root / "projects.ndjson", lines=True)
ships = pd.read_json(root / "ships.ndjson", lines=True)

# Activity status as HEY words it; UNKNOWN is a state, not a missing value.
print(projects["activityStatus"].value_counts())

# Ships per project, joined to the project's research level.
ships["slug"] = ships["project"].map(lambda p: p["slug"])
per_project = ships.groupby("slug").size().rename("ships").reset_index()
joined = per_project.merge(projects[["slug", "researchLevel"]], on="slug", how="left")
print(joined.sort_values("ships", ascending=False).head(10))

# The same question in DuckDB, straight from the file.
print(
    duckdb.sql(
        f"""
        SELECT eventType, verification, count(*) AS ships
        FROM read_ndjson_auto('{root / "ships.ndjson"}')
        GROUP BY ALL ORDER BY ships DESC
        """
    ).df()
)
