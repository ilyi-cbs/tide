"""Deterministic TabularBackend with no network calls.

Outputs are deterministic placeholders derived only from training targets.
"""

from __future__ import annotations

from typing import Any

from tabular.domain.models import (
    BackendOutput,
    Capabilities,
    ColumnSpec,
    OutputSpec,
    Task,
)
from tabular.domain.placeholders import MAJORITY_SCORE as MAJORITY_SCORE
from tabular.domain.placeholders import _quantile as _quantile
from tabular.domain.placeholders import context_prediction


class FakeBackend:
    name = "fake"
    capabilities = Capabilities(max_test_batch=10_000, max_classes=160)
    rich_outputs = True

    def fit_predict(
        self,
        *,
        task: Task,
        columns: tuple[ColumnSpec, ...],
        x_train: list[list[Any]],
        y_train: list[Any],
        x_test: list[list[Any]],
        output: OutputSpec,
        timeout_s: float = 0,
    ) -> BackendOutput:
        return context_prediction(task, y_train, len(x_test), output)
