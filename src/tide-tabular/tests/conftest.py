from __future__ import annotations

import os
import re

import pytest

from tabular.application.predict import Limits, PredictService


@pytest.fixture(autouse=True)
def isolated_settings_environment(monkeypatch):
    """Settings tests must not depend on the caller's backend or credentials."""
    for name in list(os.environ):
        if re.match(r"(TABULAR_|PRIORLABS_|AICORE_)", name):
            monkeypatch.delenv(name)


@pytest.fixture(autouse=True)
def managed_prediction_services(monkeypatch):
    services = []
    initialize = PredictService.__init__

    def tracked_initialize(service, *args, **kwargs):
        initialize(service, *args, **kwargs)
        services.append(service)

    monkeypatch.setattr(PredictService, "__init__", tracked_initialize)
    yield
    for service in reversed(services):
        service.close()


@pytest.fixture
def limits() -> Limits:
    return Limits(
        max_context_rows=100, max_test_rows=100, test_chunk_rows=2, max_concurrent_calls=2
    )


@pytest.fixture
def body() -> dict:
    """A valid POST /v1/tabular body: 3 training rows, 3 rows to predict."""
    return {
        "task": "classification",
        "columns": [
            {"name": "feature_a", "kind": "numeric"},
            {"name": "feature_b", "kind": "categorical"},
        ],
        "x_train": [[1.0, "x"], [2.0, "y"], [3.0, "x"]],
        "y_train": ["yes", "no", "yes"],
        "keys": ["r4", "r5", "r6"],
        "x_test": [[4.0, "y"], [5.0, "x"], [6.0, None]],
        "output": {"type": "probas"},
    }


@pytest.fixture
def quantile_body() -> dict:
    return {
        "task": "regression",
        "columns": [
            {"name": "Plant", "kind": "categorical"},
            {"name": "OrderQuantity", "kind": "numeric"},
        ],
        "x_train": [["P1", 1], ["P1", 2], ["P2", 3], ["P2", 4], ["P1", 5]],
        "y_train": [10, 20, 30, 40, 50],
        "keys": ["a", "b"],
        "x_test": [["P1", 6], ["P2", 7]],
        "output": {"type": "quantiles", "levels": [0.1, 0.9]},
    }
