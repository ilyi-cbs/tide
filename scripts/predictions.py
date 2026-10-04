"""Export/import stored TabPFN predictions (core prediction cache) as Parquet.

Usage: predictions.py export|import <database.sqlite> <directory>
"""

import hashlib
import json
import sqlite3
import sys
from pathlib import Path

import duckdb

RUNS = "tide_core_PredictionRun"
RESULTS = "tide_core_PredictionResult"
STORED = "stored-predictions"
VOLATILE = {"executionLease", "leaseExpiresAt", "dispatchStartedAt", "correlationId"}


def duck_type(declared: str) -> str:
    declared = declared.upper()
    if "INT" in declared:
        return "BIGINT"
    if any(kind in declared for kind in ("DOUBLE", "REAL", "FLOAT", "DECIMAL")):
        return "DOUBLE"
    return "VARCHAR"


def columns(db: sqlite3.Connection, table: str) -> list[tuple[str, str]]:
    return [(row[1], row[2]) for row in db.execute(f'PRAGMA table_info("{table}")')]


def sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def export(database: Path, directory: Path) -> None:
    db = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
    duck = duckdb.connect()
    directory.mkdir(parents=True, exist_ok=True)
    queries = {
        RUNS: f"SELECT {{}} FROM {RUNS} WHERE status = 'succeeded' ORDER BY ID",
        RESULTS: f"SELECT {{}} FROM {RESULTS} WHERE run_ID IN "
        f"(SELECT ID FROM {RUNS} WHERE status = 'succeeded') ORDER BY run_ID, rowKey",
    }
    files = {}
    for table, query in queries.items():
        cols = [(name, kind) for name, kind in columns(db, table) if name not in VOLATILE]
        names = ", ".join(f'"{name}"' for name, _ in cols)
        rows = db.execute(query.format(names)).fetchall()
        duck.execute(
            f"CREATE TABLE {table} ("
            + ", ".join(f'"{name}" {duck_type(kind)}' for name, kind in cols)
            + ")"
        )
        if rows:
            duck.executemany(
                f"INSERT INTO {table} VALUES ({', '.join('?' for _ in cols)})", rows
            )
        target = directory / f"{table.removeprefix('tide_core_')}.parquet"
        duck.execute(f"COPY {table} TO '{target}' (FORMAT parquet, COMPRESSION zstd)")
        files[target.name] = {"sha256": sha256(target), "rows": len(rows)}
    (directory / "manifest.json").write_text(
        json.dumps({"files": files}, indent=2) + "\n", encoding="utf-8"
    )
    print(f"exported {files['PredictionRun.parquet']['rows']} runs to {directory}")


def import_(database: Path, directory: Path) -> None:
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    for name, entry in manifest["files"].items():
        if sha256(directory / name) != entry["sha256"]:
            raise SystemExit(f"SHA-256 mismatch: {directory / name}")
    db = sqlite3.connect(database)
    duck = duckdb.connect()

    def rows(name: str, table: str):
        target = {name for name, _ in columns(db, table)}
        relation = duck.sql(f"SELECT * FROM read_parquet('{directory / name}')")
        keep = [column for column in relation.columns if column in target]
        return keep, relation.select(*[f'"{column}"' for column in keep]).fetchall()

    with db:
        run_cols, runs = rows("PredictionRun.parquet", RUNS)
        by = run_cols.index("createdBy") if "createdBy" in run_cols else None
        inserted = set()
        for run in runs:
            values = list(run)
            if by is not None:
                values[by] = STORED
            cursor = db.execute(
                f"INSERT OR IGNORE INTO {RUNS} ({', '.join(run_cols)}) "
                f"VALUES ({', '.join('?' for _ in run_cols)})",
                values,
            )
            if cursor.rowcount:
                inserted.add(run[run_cols.index("ID")])
        result_cols, results = rows("PredictionResult.parquet", RESULTS)
        run_id = result_cols.index("run_ID")
        db.executemany(
            f"INSERT INTO {RESULTS} ({', '.join(result_cols)}) "
            f"VALUES ({', '.join('?' for _ in result_cols)})",
            [row for row in results if row[run_id] in inserted],
        )
    db.close()
    print(f"[tide] imported {len(inserted)} of {len(runs)} stored prediction runs")


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in {"export", "import"}:
        raise SystemExit(__doc__)
    command, database, directory = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    (export if command == "export" else import_)(database, directory)
