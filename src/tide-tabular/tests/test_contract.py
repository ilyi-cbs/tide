"""The contract snapshot in tests/fixtures/ is what CAP's tests build against.

`tests/fixtures/tabular.openapi.json` is the OpenAPI document of this service and
`tests/fixtures/examples/<name>.request.json` / `.response.json` are exchanges
answered by the fake backend. Both drift checks fail when the service
changes; `UPDATE_CONTRACTS=1 uv run pytest tests/test_contract.py` rewrites
them after an intended change.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tabular.api.deps import get_predict_service
from tabular.api.main import app
from tabular.application.predict import Limits, PredictService
from tabular.infrastructure.backends.fake import FakeBackend

CONTRACTS = Path(__file__).resolve().parent / "fixtures"
EXAMPLES = CONTRACTS / "examples"
UPDATE = os.environ.get("UPDATE_CONTRACTS") == "1"

REQUESTS = {
    "probas": {
        "task": "classification",
        "columns": [
            {"name": "Plant", "kind": "categorical"},
            {"name": "OrderQuantity", "kind": "numeric"},
        ],
        "x_train": [["P1", 10], ["P1", 20], ["P2", 5], ["P2", 50]],
        "y_train": ["late", "on_time", "on_time", "late"],
        "keys": ["PO1-10", "PO2-10"],
        "x_test": [["P1", 15], ["P2", None]],
        "output": {"type": "probas"},
    },
    "point": {
        "task": "regression",
        "columns": [
            {"name": "Plant", "kind": "categorical"},
            {"name": "OrderQuantity", "kind": "numeric"},
            {"name": "PurchaseOrderType", "kind": "categorical"},
        ],
        "x_train": [["P1", 10, "NB"], ["P1", 20, "NB"], ["P2", 5, "NB"], ["P2", 50, "NB"]],
        "y_train": [12, 20, 7, 30],
        "keys": ["PO1-10"],
        "x_test": [["P1", 15, "NB"]],
        "output": {"type": "point"},
    },
    "quantiles": {
        "task": "regression",
        "columns": [
            {"name": "Plant", "kind": "categorical"},
            {"name": "OrderQuantity", "kind": "numeric"},
        ],
        "x_train": [["P1", 10], ["P1", 20], ["P2", 5], ["P2", 50], ["P1", 8]],
        "y_train": [12, 20, 7, 30, 9],
        "keys": ["PO1-10", "PO2-10"],
        "x_test": [["P1", 15], ["P2", 40]],
        "output": {"type": "quantiles", "levels": [0.1, 0.9]},
    },
    "fallback": {
        "task": "regression",
        "columns": [{"name": "Plant", "kind": "categorical"}],
        "x_train": [["P1"], ["P1"], ["P1"]],
        "y_train": [10, 20, 30],
        "keys": ["PO1-10"],
        "x_test": [["P1"]],
        "output": {"type": "quantiles", "levels": [0.1, 0.5, 0.9]},
    },
    "dry_run": {
        "task": "regression",
        "mode": "dry_run",
        "columns": [{"name": "OrderQuantity", "kind": "numeric"}],
        "x_train": [[1], [2], [3]],
        "y_train": [4, 5, 6],
        "keys": ["PO1-10"],
        "x_test": [[4]],
        "output": {"type": "point"},
    },
}


@pytest.fixture
def client():
    limits = Limits(
        max_context_rows=1000, max_test_rows=1000, test_chunk_rows=1000, max_concurrent_calls=2
    )
    service = PredictService(FakeBackend(), limits)
    app.dependency_overrides[get_predict_service] = lambda: service
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _stable(response: dict) -> dict:
    return {**response, "elapsed_ms": 0.0}


def _check(path: Path, actual: object) -> None:
    text = json.dumps(actual, indent=2, sort_keys=True) + "\n"
    if UPDATE:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return
    assert path.exists(), f"{path.name} is missing; regenerate with UPDATE_CONTRACTS=1"
    assert json.loads(path.read_text()) == actual, f"{path.name} changed"


def test_openapi_snapshot():
    _check(CONTRACTS / "tabular.openapi.json", app.openapi())


def test_v3_examples_are_versioned():
    assert not list(EXAMPLES.glob("v3-*.request.json"))
    assert len(list((EXAMPLES / "v3").glob("*.request.json"))) == 8


@pytest.mark.parametrize("name", sorted(REQUESTS))
def test_examples(client, name):
    request = REQUESTS[name]
    response = client.post("/v1/tabular", json=request)
    assert response.status_code == 200, response.text
    _check(EXAMPLES / f"{name}.request.json", request)
    _check(EXAMPLES / f"{name}.response.json", _stable(response.json()))
