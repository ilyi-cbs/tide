"""Value objects for the CAP -> tabular contract v2 (docs/api/tabular.v2.md).

CAP selects and sends rows; tabular owns no data access. These framework-free
types cover both contract versions.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal, NotRequired, TypedDict

from tabular.domain.errors import MalformedUpstream, ValidationFailure

Task = Literal["classification", "regression"]
Mode = Literal["predict", "dry_run"]
ColumnKind = Literal["numeric", "categorical", "text"]
OutputType = Literal["labels", "probas", "point", "quantiles", "summary", "distribution"]
Fallback = Literal["context_distribution", "context_quantiles"]
Cell = str | int | float | bool | None


def canonical_class_label(value: Cell) -> str:
    if (
        not isinstance(value, str | int | float | bool)
        or isinstance(value, float)
        and not math.isfinite(value)
    ):
        raise ValidationFailure("classification targets must be finite scalar labels")
    return str(value)


class FittedRecord(TypedDict):
    tabpfn_client_version: str
    task: Task
    model_id: str
    params: dict[str, Any]
    n_train_rows: int
    classes: list[Cell] | None


class ReferenceManifest(TypedDict):
    backendKey: str
    modelKey: str
    configuration_identity: str | None
    task: Task
    columns: list[dict[str, str]]
    feature_indices: list[int]
    record: FittedRecord
    training_fingerprint: str
    model_options: dict[str, Any]
    fit_options: dict[str, Any]
    version: NotRequired[int]
    expires_at: NotRequired[int]


@dataclass(frozen=True)
class ColumnSpec:
    name: str
    kind: ColumnKind


@dataclass(frozen=True)
class OutputSpec:
    type: OutputType
    levels: tuple[float, ...] = ()
    statistic: Literal["mean", "median", "mode"] = "mean"


@dataclass(frozen=True)
class PredictRequest:
    """One fit+predict: in-context training rows plus rows to predict.

    `columns` names the feature order shared by `x_train` and `x_test` rows.
    `keys[i]` identifies `x_test[i]` in the response.
    """

    task: Task
    columns: tuple[ColumnSpec, ...]
    x_train: tuple[tuple[Cell, ...], ...]
    y_train: tuple[Cell, ...]
    keys: tuple[str, ...]
    x_test: tuple[tuple[Cell, ...], ...]
    output: OutputSpec
    mode: Mode = "predict"
    model_options: tuple[tuple[str, Any], ...] = ()
    fit_options: tuple[tuple[str, Any], ...] = ()
    contract_version: Literal[2, 3] = 2


@dataclass(frozen=True)
class PredictRequestV3:
    dataset: PredictRequest
    backend_key: str
    model_key: str
    output_type: Literal["labels", "probas", "point", "quantiles", "summary", "distribution"]
    statistic: Literal["mean", "median", "mode"] = "mean"
    model_options: tuple[tuple[str, Any], ...] = ()
    fit_options: tuple[tuple[str, Any], ...] = ()


@dataclass(frozen=True)
class Prediction:
    row_key: str
    value: str | float
    probabilities: tuple[float, ...] | None = None
    quantiles: tuple[float, ...] | None = None
    mean: float | None = None
    median: float | None = None
    mode: float | None = None


@dataclass(frozen=True)
class Usage:
    backend: str
    calls: int
    context_cells: int
    predicted_cells: int
    cost_units: float
    effective_feature_count: int
    num_cells: int | None = None
    num_predictions: int | None = None
    model_version: str | None = None


@dataclass(frozen=True)
class TabularResult:
    task: Task
    output_type: OutputType
    predictions: tuple[Prediction, ...]
    classes: tuple[str, ...] | None
    levels: tuple[float, ...] | None
    fallback: Fallback | None
    dropped_columns: tuple[str, ...]
    placeholder: bool
    usage: Usage
    train_rows: int
    elapsed_ms: float
    distributions: tuple[DistributionChunk, ...] = ()
    diagnostics: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class BackendUsage:
    """What a backend reports about one call, if anything."""

    num_cells: int | None = None
    num_predictions: int | None = None
    model_version: str | None = None


@dataclass(frozen=True)
class ClassProbas:
    """One row per test row; classes[i] <-> scores[row][i]."""

    classes: tuple[str, ...]
    scores: tuple[tuple[float, ...], ...]
    usage: BackendUsage = BackendUsage()


@dataclass(frozen=True)
class Points:
    """One point (mean) per test row."""

    points: tuple[float, ...]
    usage: BackendUsage = BackendUsage()


@dataclass(frozen=True)
class QuantileGrid:
    """One row per test row, preserving the provider's level/value association."""

    levels: tuple[float, ...]
    values: tuple[tuple[float, ...], ...]
    usage: BackendUsage = BackendUsage()


@dataclass(frozen=True)
class RegressionSummary:
    means: tuple[float, ...]
    medians: tuple[float, ...]
    modes: tuple[float, ...]
    levels: tuple[float, ...]
    quantiles: tuple[tuple[float, ...], ...]
    usage: BackendUsage = BackendUsage()


@dataclass(frozen=True)
class RegressionDistribution:
    summary: RegressionSummary
    borders: tuple[float, ...]
    logits: tuple[tuple[float | None, ...], ...]
    masked_logits: tuple[tuple[bool, ...], ...]
    coordinates: Literal["target"] = "target"
    tails: Literal["full_support", "bounded_synthetic"] = "full_support"

    @property
    def usage(self) -> BackendUsage:
        return self.summary.usage


@dataclass(frozen=True)
class DistributionChunk:
    keys: tuple[str, ...]
    distribution: RegressionDistribution


def checked_quantile_row(values: tuple[float, ...]) -> tuple[float, ...]:
    if any(
        isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value)
        for value in values
    ):
        raise MalformedUpstream("backend returned non-finite quantiles")
    if any(left > right for left, right in zip(values, values[1:], strict=False)):
        raise MalformedUpstream("backend returned crossed quantiles")
    return values


BackendOutput = ClassProbas | Points | QuantileGrid | RegressionSummary | RegressionDistribution


@dataclass(frozen=True)
class Capabilities:
    """Limits of one backend; the service chunks and checks against them."""

    max_test_batch: int
    max_classes: int
