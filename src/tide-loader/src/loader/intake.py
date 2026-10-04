"""Source-only intake for the target CAP model; never restore demo results."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from contextlib import closing
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import duckdb

from loader.load import TABLES, LoadError, _base_query, detect_layout
from loader.load import _sql_column as source_column

VERSION = "source-only-v1"
CURRENT_PUBLICATION = (
    "SELECT inputRevision, load_ID, version FROM tide_source_SourcePublications "
    "WHERE name='current'"
)
# predictions/ holds stored TabPFN results, imported by scripts/predictions.py.
NON_SOURCE = {"truth", "delta", "tide-cockpit", "predictions"}
REQUIRED = {
    "PurchaseOrder",
    "PurchaseOrderItem",
    "PurchaseOrderScheduleLine",
    "MaterialDocumentHeader",
    "MaterialDocumentItem",
    "Product",
    "Supplier",
    "ProductPlantSupplyPlanning",
    "PurgInfoRecdOrgPlantData",
    "SalesOrder",
    "SalesOrderItem",
    "PurchaseReqnItem",
}
TABLES_SOURCE = tuple(table for table in TABLES if table.namespace == "s4")
# Source families each UI capability needs; a missing family makes it unavailable.
CAPABILITIES = {
    "delivery": (
        "PurchaseOrder",
        "PurchaseOrderItem",
        "PurchaseOrderScheduleLine",
        "MaterialDocumentItem",
        "SupplierConfirmationItem",
        "SalesOrder",
        "SalesOrderItem",
        "ProductPlantMRP",
        "ProductionOrder",
        "ProductionOrderComponent",
    ),
    "prevention": (
        "PurchaseOrderItem",
        "ProductDescription",
        "ProductPlantSupplyPlanning",
        "PurgInfoRecdOrgPlantData",
        "Supplier",
    ),
    "requisition": (
        "PurchaseReqn",
        "PurchaseReqnItem",
        "PurchaseReqnAcctAssgmt",
        "PurchaseReqnItemText",
        "PurchaseOrderItem",
        "ProductGroupText",
        "PurchasingGroup",
    ),
    "accounting": (
        "AccountingCompanyCode",
        "GLAccountCompany",
        "AccountingCostCenter",
        "PurchaseReqnAcctAssgmt",
    ),
    "planning": (
        "ProductPlant",
        "ProductPlantMRP",
        "PlannedIndepRqmt",
        "PlannedIndepRqmtItem",
        "PurgInfoRecdOrgPlantData",
        "PurchaseOrderItem",
    ),
    "currency": ("ExchangeRate",),
}


def readiness(
    absent: list[str], missing_columns: dict[str, list[str]], counts: dict[str, int]
) -> dict[str, dict]:
    result = {}
    for name, families in CAPABILITIES.items():
        reasons = [f"{family}: not supplied" for family in families if family in absent]
        reasons += [
            f"{family}: no rows"
            for family in families
            if family not in absent and not counts.get(family)
        ]
        reasons += [
            f"{family}: missing {', '.join(missing_columns[family])}"
            for family in families
            if family in missing_columns
        ]
        unavailable = any(not counts.get(family) for family in families)
        result[name] = {
            "status": "unavailable" if unavailable else "partial" if reasons else "ready",
            "reasons": reasons,
        }
    return result


def inventory(source: Path) -> tuple[dict, str, dict]:
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise LoadError("manifest.json must contain an object")
    hashes = manifest.get("file_sha256")
    rows = manifest.get("rows")
    if not isinstance(hashes, dict) or not isinstance(rows, dict):
        raise LoadError("manifest needs file_sha256 and rows inventories")
    files = sorted(
        path
        for path in source.rglob("*.parquet")
        if path.relative_to(source).parts[0] not in NON_SOURCE
    )
    if not files:
        raise LoadError("No source Parquet files found")
    verified = {}
    for filename in files:
        relative = filename.relative_to(source).as_posix()
        if not filename.resolve().is_relative_to(source):
            raise LoadError(f"Source file resolves outside the dataset: {relative}")
        entity_path = relative.removesuffix(".parquet")
        expected = hashes.get(entity_path)
        if not isinstance(expected, str):
            raise LoadError(f"Missing SHA-256 inventory entry: {relative}")
        with filename.open("rb") as handle:
            actual = hashlib.file_digest(handle, "sha256").hexdigest()
        if actual != expected:
            raise LoadError(f"SHA-256 mismatch: {relative}")
        count = rows.get(entity_path)
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise LoadError(f"Missing or invalid row inventory entry: {relative}")
        verified[relative] = {"sha256": actual, "rows": count}
    for relative in hashes:
        filename = Path(relative)
        if filename.is_absolute() or ".." in filename.parts:
            raise LoadError(f"Unsafe inventory path: {relative}")
        if filename.parts[0] not in NON_SOURCE and f"{relative}.parquet" not in verified:
            raise LoadError(f"Missing source file: {relative}")
    identity = hashlib.sha256(
        json.dumps(verified, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return manifest, identity, verified


def load(
    source: Path, database: Path, *, as_of: str | None = None, source_system: str = "local-demo"
) -> dict:
    source = source.resolve()
    if "'" in str(source):
        raise LoadError("Source paths containing quotes are not supported by the mappings")
    if not source_system.strip() or len(source_system) > 80:
        raise LoadError("source-system must contain 1 to 80 characters")
    manifest, content, verified = inventory(source)
    business_date_value = as_of or manifest.get("today")
    if not isinstance(business_date_value, str):
        raise LoadError("The manifest needs today, or supply --as-of, as an ISO date")
    business_date = date.fromisoformat(business_date_value).isoformat()
    layout = detect_layout(source)
    if layout != "synthetic" or manifest.get("containsCustomerData") is not False:
        raise LoadError(
            "This intake supports attested demo input only; actual-source intake is not certified"
        )
    revision = hashlib.sha256(
        json.dumps([content, business_date, source_system, VERSION]).encode()
    ).hexdigest()
    with (
        duckdb.connect() as parquet,
        closing(
            sqlite3.connect(database.resolve().as_uri() + "?mode=rw", uri=True, timeout=30)
        ) as database_connection,
    ):
        database_connection.execute("PRAGMA busy_timeout=30000")
        available_tables = {
            row[0]
            for row in database_connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        required_tables = {table.sql_table for table in TABLES_SOURCE} | {
            "tide_s4_DatasetInfo",
            "tide_source_SourceLoads",
            "tide_source_SourcePublications",
            "tide_source_IngestOperations",
        }
        missing_tables = required_tables - available_tables
        if missing_tables:
            raise LoadError(
                "Existing database needs an approved schema migration; "
                f"never reset retained history. Missing tables: {sorted(missing_tables)}"
            )
        current = database_connection.execute(CURRENT_PUBLICATION).fetchone()
        if current and current[0] == revision:
            return {"status": "unchanged", "loadId": current[1], "inputRevision": revision}
        counts: dict[str, int] = {}
        absent: list[str] = []
        missing_columns: dict[str, list[str]] = {}
        for relative, expected in verified.items():
            count = parquet.execute(
                "SELECT count(*) FROM read_parquet(?)", [str(source / relative)]
            ).fetchone()[0]
            if count != expected["rows"]:
                raise LoadError(f"Row count mismatch: {relative}")
        for table in TABLES_SOURCE:
            base = _base_query(table, source, layout)
            if base is None:
                absent.append(table.entity)
                counts[table.entity] = 0
                continue
            available = {row[0] for row in parquet.execute(f"DESCRIBE {base}").fetchall()}
            missing_keys = set(table.keys) - available
            if missing_keys:
                raise LoadError(f"{table.entity}: missing keys {sorted(missing_keys)}")
            missing = [
                column.name
                for column in table.columns
                if (column.source or column.name) not in available
            ]
            if missing:
                missing_columns[table.entity] = missing
            columns = ", ".join(
                source_column(column, available, layout) for column in table.columns
            )
            parquet.execute(
                f'CREATE TEMP TABLE "{table.entity}" AS SELECT DISTINCT {columns} FROM ({base})'
            )
            keys = ", ".join(f'"{key}"' for key in table.keys)
            invalid = " OR ".join(f'"{key}" IS NULL' for key in table.keys)
            if parquet.execute(
                f'SELECT 1 FROM "{table.entity}" WHERE {invalid} LIMIT 1'
            ).fetchone():
                raise LoadError(f"{table.entity}: null source key")
            conflict = parquet.execute(
                f'SELECT {keys} FROM "{table.entity}" GROUP BY {keys} HAVING count(*) > 1 LIMIT 1'
            ).fetchone()
            if conflict:
                raise LoadError(f"{table.entity}: conflicting duplicate source key {conflict}")
            counts[table.entity] = parquet.execute(
                f'SELECT count(*) FROM "{table.entity}"'
            ).fetchone()[0]
        missing_required = REQUIRED & set(absent)
        if missing_required:
            raise LoadError(f"Missing required source families: {sorted(missing_required)}")
        manifest_after, content_after, _ = inventory(source)
        if content_after != content or manifest_after != manifest:
            raise LoadError("Source changed during preflight; retry intake")
        load_id = str(uuid4())
        operation_id = str(uuid4())
        ingested_at = datetime.now(UTC).isoformat(timespec="milliseconds")
        quality = json.dumps(
            {
                "absentTables": absent,
                "missingColumns": missing_columns,
                "capabilities": readiness(absent, missing_columns, counts),
            },
            sort_keys=True,
        )
        with database_connection:
            database_connection.execute("BEGIN IMMEDIATE")
            latest = database_connection.execute(CURRENT_PUBLICATION).fetchone()
            if latest != current:
                raise LoadError("Source publication changed during preflight; retry intake")
            for table in TABLES_SOURCE:
                database_connection.execute(f"DELETE FROM {table.sql_table}")
                if table.entity in absent:
                    continue
                names = ", ".join(f'"{column.name}"' for column in table.columns)
                placeholders = ", ".join("?" for column in table.columns)
                cursor = parquet.execute(f'SELECT * FROM "{table.entity}"')
                while chunk := cursor.fetchmany(50_000):
                    database_connection.executemany(
                        f"INSERT INTO {table.sql_table} ({names}) VALUES ({placeholders})",
                        [
                            tuple(
                                str(value) if isinstance(value, Decimal) else value for value in row
                            )
                            for row in chunk
                        ],
                    )
            database_connection.execute(
                "INSERT INTO tide_source_SourceLoads "
                "(ID, sourceSystem, sourceType, asOf, ingestedAt, contentIdentity, schemaVersion, "
                "normalizationVersion, trusted, completeness, quality) "
                "VALUES (?, ?, 'demo', ?, ?, ?, ?, ?, 0, ?, ?)",
                (
                    load_id,
                    source_system,
                    business_date,
                    ingested_at,
                    content,
                    VERSION,
                    VERSION,
                    "partial" if absent or missing_columns else "complete",
                    quality,
                ),
            )
            database_connection.execute(
                "INSERT INTO tide_source_SourcePublications "
                "(name, load_ID, inputRevision, version) "
                "VALUES ('current', ?, ?, ?) ON CONFLICT(name) DO UPDATE SET "
                "load_ID=excluded.load_ID, inputRevision=excluded.inputRevision, "
                "version=excluded.version",
                (load_id, revision, current[2] + 1 if current else 1),
            )
            database_connection.execute(
                "INSERT INTO tide_source_IngestOperations "
                "(ID, batchIdentity, baseRevision, targetRevision, stageResults, status, "
                "correlation) "
                "VALUES (?, ?, ?, ?, ?, 'completed', ?)",
                (
                    operation_id,
                    content,
                    current[0] if current else None,
                    revision,
                    json.dumps({"rows": counts, "quality": json.loads(quality)}),
                    load_id,
                ),
            )
            database_connection.execute("DELETE FROM tide_s4_DatasetInfo")
            database_connection.execute(
                "INSERT INTO tide_s4_DatasetInfo "
                "(ID, name, source, asOf, historyStart, containsCustomerData, loadId, loadedAt, "
                "rowCounts, absentTables) "
                "VALUES ('current', ?, 'synthetic', ?, ?, 0, ?, ?, ?, ?)",
                (
                    manifest.get("profile", source.name),
                    business_date,
                    manifest.get("history_start"),
                    load_id,
                    ingested_at,
                    json.dumps(counts, sort_keys=True),
                    json.dumps(absent),
                ),
            )
        return {
            "status": "loaded",
            "loadId": load_id,
            "inputRevision": revision,
            "sourceType": "demo",
            "rows": counts,
            "quality": json.loads(quality),
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--as-of")
    parser.add_argument("--source-system", default="local-demo")
    arguments = parser.parse_args()
    try:
        result = load(
            arguments.source,
            arguments.db,
            as_of=arguments.as_of,
            source_system=arguments.source_system,
        )
    except (LoadError, OSError, ValueError, sqlite3.Error, duckdb.Error) as error:
        print(f"Source intake failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
