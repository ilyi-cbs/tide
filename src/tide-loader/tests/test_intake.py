from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

import pytest

from loader.delta import delta_dates, read_delta
from loader.intake import NON_SOURCE, inventory, load, readiness
from loader.load import LoadError, detect_layout

DEMO = Path(__file__).resolve().parents[3] / "data" / "demo"
SCHEMA = Path(__file__).with_name("schema.sql")


@pytest.fixture(scope="module")
def manifest() -> dict:
    return json.loads((DEMO / "manifest.json").read_text(encoding="utf-8"))


@pytest.fixture
def source_copy(tmp_path: Path) -> Path:
    target = tmp_path / "demo"
    target.mkdir()
    shutil.copy2(DEMO / "manifest.json", target / "manifest.json")
    for entry in DEMO.iterdir():
        if entry.is_dir() and entry.name not in NON_SOURCE:
            shutil.copytree(entry, target / entry.name)
        elif entry.suffix == ".parquet":
            shutil.copy2(entry, target / entry.name)
    return target


@pytest.fixture
def database(tmp_path: Path) -> Path:
    filename = tmp_path / "cap.sqlite"
    with sqlite3.connect(filename) as connection:
        connection.executescript(SCHEMA.read_text(encoding="utf-8"))
    return filename


def rewrite_manifest(source: Path, change) -> None:
    filename = source / "manifest.json"
    manifest = json.loads(filename.read_text(encoding="utf-8"))
    change(manifest)
    filename.write_text(json.dumps(manifest), encoding="utf-8")


def test_detect_layout(tmp_path: Path) -> None:
    assert detect_layout(DEMO) == "synthetic"
    with pytest.raises(LoadError, match="neither"):
        detect_layout(tmp_path)


def test_inventory_verifies_demo_hashes_and_skips_non_source(manifest: dict) -> None:
    _, identity, verified = inventory(DEMO)
    assert len(identity) == 64
    assert verified
    assert all(Path(relative).parts[0] not in NON_SOURCE for relative in verified)
    entity = "API_PURCHASEORDER_2/PurchaseOrder"
    assert verified[f"{entity}.parquet"]["rows"] == manifest["rows"][entity]


def test_inventory_rejects_changed_hash(source_copy: Path) -> None:
    entity = "API_PURCHASEORDER_2/PurchaseOrder"
    rewrite_manifest(source_copy, lambda m: m["file_sha256"].__setitem__(entity, "0" * 64))
    with pytest.raises(LoadError, match="SHA-256 mismatch"):
        inventory(source_copy)


def test_inventory_rejects_unlisted_and_missing_files(source_copy: Path) -> None:
    entity = "API_PURCHASEORDER_2/PurchaseOrder"
    rewrite_manifest(source_copy, lambda m: m["file_sha256"].pop(entity))
    with pytest.raises(LoadError, match="Missing SHA-256 inventory entry"):
        inventory(source_copy)
    rewrite_manifest(source_copy, lambda m: m["file_sha256"].__setitem__("X/Absent", "0" * 64))
    (source_copy / f"{entity}.parquet").unlink()
    with pytest.raises(LoadError, match="Missing source file"):
        inventory(source_copy)


def test_readiness_marks_missing_families() -> None:
    result = readiness(["ExchangeRate"], {"ProductPlantSupplyPlanning": ["X"]}, {"Supplier": 1})
    assert result["currency"]["status"] == "unavailable"
    assert "ExchangeRate: not supplied" in result["currency"]["reasons"]
    assert result["prevention"]["status"] == "unavailable"


def test_load_rejects_customer_data(source_copy: Path, database: Path) -> None:
    rewrite_manifest(source_copy, lambda m: m.__setitem__("containsCustomerData", True))
    with pytest.raises(LoadError, match="attested demo input only"):
        load(source_copy, database)


def test_demo_loads_once_and_is_idempotent(database: Path, manifest: dict) -> None:
    result = load(DEMO, database)
    assert result["status"] == "loaded"
    assert result["sourceType"] == "demo"
    assert result["rows"]["PurchaseOrder"] == manifest["rows"]["API_PURCHASEORDER_2/PurchaseOrder"]
    with sqlite3.connect(database) as connection:
        stored = connection.execute("SELECT count(*) FROM tide_s4_PurchaseOrder").fetchone()[0]
        info = connection.execute("SELECT asOf, loadId FROM tide_s4_DatasetInfo").fetchone()
    assert stored == result["rows"]["PurchaseOrder"]
    assert info == (manifest["today"], result["loadId"])
    again = load(DEMO, database)
    assert again == {
        "status": "unchanged",
        "loadId": result["loadId"],
        "inputRevision": result["inputRevision"],
    }


def test_delta_batches_are_readable(manifest: dict) -> None:
    dates = delta_dates(DEMO)
    assert dates == manifest["delta"]
    rows = read_delta(DEMO, dates[0])
    assert rows
    assert all(isinstance(batch, list) and batch for batch in rows.values())
    with pytest.raises(LoadError, match="no such delta batch"):
        read_delta(DEMO, "2026-01-01")
