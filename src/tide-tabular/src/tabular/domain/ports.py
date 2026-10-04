"""The one outbound port the application layer depends on.

tabular owns no data access: CAP sends the rows. The backend is the only
side effect, so it is the only port.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from tabular.domain.models import (
    BackendOutput,
    Capabilities,
    ColumnSpec,
    FittedRecord,
    OutputSpec,
    Task,
)


class PredictionBackend(Protocol):
    """Fit on train rows, predict on test rows. One call, no persisted model.

    `columns` describes every row; only varying columns reach a backend.
    `output` is `probas` for classification, `point` or `quantiles` for
    regression. `timeout_s` is the time left for this call; adapters must not
    exceed it.
    """

    name: str
    capabilities: Capabilities

    def fit_predict(
        self,
        *,
        task: Task,
        columns: tuple[ColumnSpec, ...],
        x_train: list[list[Any]],
        y_train: list[Any],
        x_test: list[list[Any]],
        output: OutputSpec,
        timeout_s: float,
    ) -> BackendOutput: ...


TabularBackend = PredictionBackend


class FittedPredictor(Protocol):
    def predict(
        self, x_test: list[list[Any]], *, output: OutputSpec, timeout_s: float
    ) -> BackendOutput: ...

    def export(self) -> FittedRecord: ...


@runtime_checkable
class FittedCapacity(Protocol):
    def batch_limit(self, output: OutputSpec) -> int | None: ...


@runtime_checkable
class FittedDiagnostics(Protocol):
    def describe(self) -> dict[str, Any]: ...


@runtime_checkable
class RichOutputBackend(Protocol):
    rich_outputs: bool


@runtime_checkable
class ClosableBackend(Protocol):
    def close(self) -> None: ...


@runtime_checkable
class FittedModelBackend(Protocol):
    def fit(
        self,
        *,
        task: Task,
        columns: tuple[ColumnSpec, ...],
        x_train: list[list[Any]],
        y_train: list[Any],
        model_options: dict[str, Any],
        fit_options: dict[str, Any],
        timeout_s: float,
    ) -> FittedPredictor: ...


@runtime_checkable
class ReferenceBackend(FittedModelBackend, Protocol):
    def restore(
        self,
        record: FittedRecord,
        *,
        task: Task,
        columns: tuple[ColumnSpec, ...],
        timeout_s: float,
    ) -> FittedPredictor: ...


@runtime_checkable
class ReferenceTemplateBackend(ReferenceBackend, Protocol):
    def reference_template(
        self,
        *,
        task: Task,
        columns: tuple[ColumnSpec, ...],
        y_train: list[Any],
        model_options: dict[str, Any],
        fit_options: dict[str, Any],
    ) -> FittedRecord: ...
