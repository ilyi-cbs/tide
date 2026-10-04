"""Read verified source delta batches without applying or resetting database state."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from pathlib import Path

import duckdb

from loader.intake import inventory, source_column
from loader.load import TABLES, LoadError, _base_query


def delta_dates(source: Path) -> list[str]:
    root = source / "delta"
    if not root.is_dir():
        return []
    dates = []
    for directory in root.iterdir():
        try:
            parsed = date.fromisoformat(directory.name)
        except ValueError:
            continue
        if directory.is_dir() and directory.name == parsed.isoformat():
            dates.append(directory.name)
    return sorted(dates)


def read_delta(source: Path, day: str, *, plants: list[str] | None = None) -> dict:
    if date.fromisoformat(day).isoformat() != day:
        raise LoadError("Delta date must use YYYY-MM-DD")
    source = source.resolve()
    if "'" in str(source):
        raise LoadError("Source paths containing quotes are not supported by the mappings")
    batch = source / "delta" / day
    if not batch.is_dir():
        raise LoadError(f"{batch}: no such delta batch (available: {delta_dates(source)})")
    manifest, content, verified = inventory(batch)
    if manifest.get("date") != day:
        raise LoadError("Delta manifest date does not match the batch directory")
    result = {}
    with duckdb.connect() as parquet:
        for relative, expected in verified.items():
            count = parquet.execute(
                "SELECT count(*) FROM read_parquet(?)", [str(batch / relative)]
            ).fetchone()[0]
            if count != expected["rows"]:
                raise LoadError(f"Row count mismatch: {relative}")
        for table in TABLES:
            base = _base_query(table, batch, "synthetic")
            if base is None:
                continue
            available = {row[0] for row in parquet.execute(f"DESCRIBE {base}").fetchall()}
            missing_keys = set(table.keys) - available
            if missing_keys:
                raise LoadError(f"{table.entity}: missing keys {sorted(missing_keys)}")
            columns = ", ".join(
                source_column(column, available, "synthetic") for column in table.columns
            )
            parquet.execute(
                f'CREATE TEMP TABLE "{table.entity}" AS SELECT DISTINCT {columns} FROM ({base})'
            )
            invalid = " OR ".join(f'"{key}" IS NULL' for key in table.keys)
            if parquet.execute(
                f'SELECT 1 FROM "{table.entity}" WHERE {invalid} LIMIT 1'
            ).fetchone():
                raise LoadError(f"{table.entity}: null source key")
            keys = ", ".join(f'"{key}"' for key in table.keys)
            conflict = parquet.execute(
                f'SELECT {keys} FROM "{table.entity}" GROUP BY {keys} HAVING count(*) > 1 LIMIT 1'
            ).fetchone()
            if conflict:
                raise LoadError(f"{table.entity}: conflicting duplicate source key {conflict}")
            query = f'SELECT * FROM "{table.entity}"'
            parameters = []
            if plants and table.plant and table.plant in available:
                query += f' WHERE "{table.plant}" IN ({", ".join("?" for _ in plants)})'
                parameters = plants
            names = [column.name for column in table.columns]
            rows = [
                {
                    name: (
                        str(value)
                        if isinstance(value, Decimal)
                        else bool(value)
                        if column.kind == "bool" and value is not None
                        else value
                    )
                    for name, column, value in zip(names, table.columns, row, strict=True)
                }
                for row in parquet.execute(query, parameters).fetchall()
            ]
            if rows:
                result[table.entity] = rows
    manifest_after, content_after, _ = inventory(batch)
    if content_after != content or manifest_after != manifest:
        raise LoadError("Source changed while reading the delta; retry intake")
    return result
