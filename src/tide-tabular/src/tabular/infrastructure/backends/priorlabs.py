"""Prior Labs adapter: direct calls into the `tabpfn-client` library.

The SDK owns transport and may retry internally, so this layer adds no retries
and reports uncertain outcomes without replaying the request.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, cast

import httpx
import numpy as np
import pandas as pd
from tabpfn_client import TabPFNClassifier, TabPFNRegressor, set_access_token
from tabpfn_client.api_models import GetSettingsResponse, ModelLimit
from tabpfn_client.client import ServiceClient
from tabpfn_client.errors import (
    CappedRetryableServerError,
    FittedModelNotFoundError,
    RetryableServerError,
)
from tabpfn_client.models import ClientOptions

from tabular.domain.errors import (
    ConfigurationError,
    MalformedUpstream,
    ModelReferenceInvalid,
    OutcomeUnknown,
    UnsupportedCapability,
    UpstreamRejected,
    UpstreamTimeout,
)
from tabular.domain.models import (
    BackendOutput,
    BackendUsage,
    Capabilities,
    ClassProbas,
    ColumnSpec,
    FittedRecord,
    OutputSpec,
    Points,
    QuantileGrid,
    RegressionDistribution,
    RegressionSummary,
    Task,
    canonical_class_label,
    checked_quantile_row,
)
from tabular.settings import PriorLabsConfig

_CREDENTIAL_LOCK = threading.Lock()
_CREDENTIAL_BINDING: str | None = None


class PriorLabsBackend:
    """`TabularBackend` backed directly by the Prior Labs TabPFN cloud API."""

    name = "priorlabs"
    rich_outputs = True

    def __init__(self, settings: PriorLabsConfig) -> None:
        self.capabilities = Capabilities(settings.max_test_batch, settings.max_classes)
        self._settings = settings
        # No network call: this only sets process-global client state (the
        # tabpfn_client httpx client's Authorization header). Actual
        # authentication happens lazily inside fit()/predict().
        global _CREDENTIAL_BINDING
        binding = hashlib.sha256(settings.api_key.encode()).hexdigest()
        with _CREDENTIAL_LOCK:
            if _CREDENTIAL_BINDING is not None and _CREDENTIAL_BINDING != binding:
                raise ConfigurationError("Prior Labs permits one credential binding per process")
            set_access_token(settings.api_key)
            _CREDENTIAL_BINDING = binding

    def _options(
        self,
        columns: tuple[ColumnSpec, ...],
        model_options: dict[str, Any],
        fit_options: dict[str, Any],
        timeout_s: float,
    ) -> dict[str, Any]:
        options = {
            "model_path": self._settings.model_path,
            "categorical_features_indices": [
                index for index, column in enumerate(columns) if column.kind == "categorical"
            ],
            "client_options": ClientOptions(timeout=timeout_s),
            **model_options,
        }
        aliases = {
            "fit_timeout": "thinking_timeout_s",
            "group_columns": "group_col",
            "time_column": "time_col",
            "grouped_time_column": "group_time_col",
        }
        options.update({aliases.get(key, key): value for key, value in fit_options.items()})
        return options

    def reference_template(
        self,
        *,
        task: Task,
        columns: tuple[ColumnSpec, ...],
        y_train: list[Any],
        model_options: dict[str, Any],
        fit_options: dict[str, Any],
    ) -> FittedRecord:
        constructor = TabPFNClassifier if task == "classification" else TabPFNRegressor
        model = constructor(**self._options(columns, model_options, fit_options, 1.0))
        params = {
            key: value
            for key, value in model.get_params(deep=False).items()
            if key != "client_options"
        }
        return cast(
            FittedRecord,
            json.loads(
                json.dumps(
                    {
                        "tabpfn_client_version": "0.6.0",
                        "task": task,
                        "model_id": "00000000-0000-0000-0000-000000000000",
                        "params": params,
                        "n_train_rows": len(y_train),
                        "classes": sorted({canonical_class_label(target) for target in y_train})
                        if task == "classification"
                        else None,
                    },
                    allow_nan=False,
                )
            ),
        )

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
    ) -> PriorLabsFitted:
        deadline = time.monotonic() + timeout_s
        if timeout_s <= 0:
            raise UpstreamTimeout("Prior Labs deadline reached before dispatch")
        frame = pd.DataFrame(x_train, columns=[column.name for column in columns], dtype=object)
        options = self._options(columns, model_options, fit_options, timeout_s)
        _before_fit(options, deadline)
        with _provider_errors():
            response = ServiceClient.httpx_client.get(
                "/tabpfn/get_settings", timeout=max(0.001, deadline - time.monotonic())
            )
            response.raise_for_status()
            try:
                settings = GetSettingsResponse.model_validate(response.json())
            except ValueError as error:
                raise MalformedUpstream("Prior Labs returned invalid service settings") from error
            selected_limits = next(
                (
                    limit
                    for version, limit in settings.model_limits.items()
                    if self._settings.model_path.startswith(f"{version.value}_")
                    or f"-{version.value}-" in self._settings.model_path
                ),
                None,
            )
            if selected_limits is None:
                raise UnsupportedCapability("selected model has no verified service limits")
            if (
                len(x_train) > selected_limits.train_set_max_rows
                or len(columns) > selected_limits.max_cols
                or len(x_train) * len(columns) > selected_limits.train_set_max_cells
                or task == "classification"
                and len({canonical_class_label(value) for value in y_train})
                > selected_limits.max_classes
            ):
                raise UpstreamRejected("training input exceeds provider model limits")
            if fit_options.get(
                "fit_mode"
            ) == "fit_with_cache" and not self._settings.model_path.startswith(
                ("v3_", "v3.5_", "v3.5-fast_")
            ):
                raise UnsupportedCapability("managed KV cache requires a TabPFN-3+ model")
            constructor = TabPFNClassifier if task == "classification" else TabPFNRegressor
            model = constructor(**options)
            _before_fit(options, deadline)
            targets = (
                [canonical_class_label(target) for target in y_train]
                if task == "classification"
                else y_train
            )
            model.fit(frame, np.asarray(targets))
            _remaining(deadline)
        return PriorLabsFitted(model, task, columns, selected_limits, len(x_train))

    def restore(
        self,
        record: FittedRecord,
        *,
        task: Task,
        columns: tuple[ColumnSpec, ...],
        timeout_s: float,
    ) -> PriorLabsFitted:
        if timeout_s <= 0:
            raise UpstreamTimeout("Prior Labs deadline reached before reference restoration")
        deadline = time.monotonic() + timeout_s
        if record.get("params", {}).get("model_path") != self._settings.model_path:
            raise ModelReferenceInvalid("model reference belongs to another model")
        try:
            constructor = TabPFNClassifier if task == "classification" else TabPFNRegressor
            model = constructor.load_model(record)
        except (ValueError, TypeError, KeyError) as error:
            raise ModelReferenceInvalid("invalid fitted-model reference") from error
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise UpstreamTimeout("Prior Labs deadline reached before reference prediction")
        with _provider_errors():
            response = ServiceClient.httpx_client.get("/tabpfn/get_settings", timeout=remaining)
            response.raise_for_status()
            try:
                settings = GetSettingsResponse.model_validate(response.json())
            except ValueError as error:
                raise MalformedUpstream("Prior Labs returned invalid service settings") from error
        limits = next(
            (
                limit
                for version, limit in settings.model_limits.items()
                if self._settings.model_path.startswith(f"{version.value}_")
                or f"-{version.value}-" in self._settings.model_path
            ),
            None,
        )
        if limits is None:
            raise UnsupportedCapability("selected model has no verified service limits")
        if time.monotonic() >= deadline:
            raise UpstreamTimeout("deadline reached before reference prediction")
        return PriorLabsFitted(model, task, columns, limits, record.get("n_train_rows"))

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
    ) -> BackendOutput:
        deadline = time.monotonic() + timeout_s
        if timeout_s <= 0:
            raise UpstreamTimeout("Prior Labs deadline reached before dispatch")
        # dtype=object preserves mixed types (numbers, strings) so
        # tabpfn_client's own text-column cleanup can tell them apart.
        x_train_arr = np.asarray(x_train, dtype=object)
        x_test_arr = np.asarray(x_test, dtype=object)
        y_train_arr = np.asarray(y_train)
        categorical = [
            index for index, column in enumerate(columns) if column.kind == "categorical"
        ]
        options = {
            "model_path": self._settings.model_path,
            "categorical_features_indices": categorical,
            "client_options": ClientOptions(timeout=timeout_s),
        }
        try:
            if output.type == "probas":
                return _fit_predict_classification(
                    x_train_arr, y_train_arr, x_test_arr, options, deadline
                )
            return _fit_predict_regression(
                x_train_arr, y_train_arr, x_test_arr, output, options, deadline
            )
        except httpx.TimeoutException as exc:
            raise OutcomeUnknown("Prior Labs request timed out; outcome unknown") from exc
        except httpx.HTTPError as exc:
            raise OutcomeUnknown(
                f"Prior Labs transport error: {type(exc).__name__}; outcome unknown"
            ) from exc
        except (RetryableServerError, CappedRetryableServerError) as exc:
            raise OutcomeUnknown("Prior Labs server error; outcome unknown") from exc
        except FittedModelNotFoundError as exc:
            raise OutcomeUnknown("Prior Labs fitted model not found; outcome unknown") from exc
        except ValueError as exc:
            raise UpstreamRejected("Prior Labs rejected the data") from exc
        except RuntimeError as exc:
            raise OutcomeUnknown("Prior Labs request failed; outcome unknown") from exc

    def close(self) -> None:
        """No adapter-owned client; do not close the SDK's process-global client."""


def _remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise OutcomeUnknown("Prior Labs deadline reached after fit; prediction not dispatched")
    return remaining


def _fit_predict_classification(
    x_train: np.ndarray, y_train: np.ndarray, x_test: np.ndarray, options: dict, deadline: float
) -> ClassProbas:
    model = TabPFNClassifier(**options)
    _before_fit(options, deadline)
    model.fit(x_train, y_train)
    options["client_options"].timeout = _remaining(deadline)
    probas = model.predict_proba(x_test)
    _remaining(deadline)
    labels = _prediction_array(getattr(model, "classes_", None), 1)
    probabilities = _prediction_array(probas, 2)
    if not len(labels) or probabilities.shape != (len(x_test), len(labels)):
        raise MalformedUpstream("Prior Labs returned invalid classification dimensions")
    classes = tuple(str(label) for label in labels)
    scores = tuple(tuple(_as_finite_float(value) for value in row) for row in probabilities)
    return ClassProbas(
        classes=classes, scores=scores, usage=BackendUsage(model_version=model.model_path)
    )


def _fit_predict_regression(
    x_train: np.ndarray,
    y_train: np.ndarray,
    x_test: np.ndarray,
    output: OutputSpec,
    options: dict,
    deadline: float,
) -> BackendOutput:
    model = TabPFNRegressor(**options)
    _before_fit(options, deadline)
    model.fit(x_train, y_train)
    options["client_options"].timeout = _remaining(deadline)
    selected = {
        "point": output.statistic,
        "quantiles": "quantiles",
        "summary": "main",
        "distribution": "full",
    }[output.type]
    kwargs: dict[str, Any] = {"output_type": selected}
    if output.type != "point":
        kwargs["quantiles"] = list(output.levels)
    points = model.predict(x_test, **kwargs)
    _remaining(deadline)
    return _parse_regression(points, len(x_test), output, model.model_path)


class PriorLabsFitted:
    def __init__(
        self,
        model: Any,
        task: Task,
        columns: tuple[ColumnSpec, ...],
        limits: ModelLimit | None = None,
        train_rows: int | None = None,
    ) -> None:
        self._model = model
        self._task = task
        self._columns = columns
        self._limits = limits
        self._train_rows = train_rows
        self._limits_observed_at = int(time.time())

    def describe(self) -> dict[str, Any]:
        timings = self._model.get_timings()
        safe_timings = {
            stage: {
                key: float(value)
                for key, value in values.items()
                if isinstance(value, int | float)
                and not isinstance(value, bool)
                and np.isfinite(value)
            }
            for stage, values in timings.items()
            if isinstance(values, dict)
        }
        return {
            "provider_limits": self._limits.model_dump() if self._limits else None,
            "limits_observed_at": self._limits_observed_at,
            "limits_refresh": "fresh per fit/import; frozen for this session",
            "timings": safe_timings,
            "effective_model_options": {
                key: value
                for key, value in self._model.get_params(deep=False).items()
                if key
                in (
                    "model_path",
                    "n_estimators",
                    "random_state",
                    "softmax_temperature",
                    "balance_probabilities",
                    "average_before_softmax",
                    "inference_precision",
                    "inference_config",
                    "ignore_pretraining_limits",
                    "paper_version",
                    "fit_mode",
                )
            },
        }

    def batch_limit(self, output: OutputSpec) -> int | None:
        if self._limits is None:
            return None
        maximum = min(
            self._limits.test_set_max_rows,
            self._limits.test_set_max_cells // max(1, len(self._columns)),
            self._limits.predict_row_pairs_budget // max(1, self._train_rows or 1),
        )
        if output.type == "distribution":
            maximum = min(maximum, self._limits.test_set_max_rows_w_full_regression_output)
        if maximum <= 0:
            raise UpstreamRejected("training input leaves no provider prediction capacity")
        return maximum

    def export(self) -> FittedRecord:
        return cast(FittedRecord, self._model.save_model())

    def predict(
        self, x_test: list[list[Any]], *, output: OutputSpec, timeout_s: float
    ) -> BackendOutput:
        deadline = time.monotonic() + timeout_s
        if timeout_s <= 0:
            raise UpstreamTimeout("Prior Labs deadline reached before prediction")
        frame = pd.DataFrame(
            x_test, columns=[column.name for column in self._columns], dtype=object
        )
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise UpstreamTimeout("Prior Labs deadline reached before prediction")
        self._model.client_options.timeout = remaining
        with _provider_errors():
            if self._task == "classification":
                probabilities = _prediction_array(self._model.predict_proba(frame), 2)
                _remaining(deadline)
                classes = tuple(str(label) for label in _prediction_array(self._model.classes_, 1))
                if probabilities.shape != (len(x_test), len(classes)):
                    raise MalformedUpstream("Prior Labs returned invalid classification dimensions")
                return ClassProbas(
                    classes=classes,
                    scores=tuple(
                        tuple(_as_finite_float(value) for value in row) for row in probabilities
                    ),
                    usage=BackendUsage(model_version=self._model.model_path),
                )
            selected = {
                "point": output.statistic,
                "quantiles": "quantiles",
                "summary": "main",
                "distribution": "full",
            }[output.type]
            kwargs: dict[str, Any] = {"output_type": selected}
            if output.type != "point":
                kwargs["quantiles"] = list(output.levels)
            result = self._model.predict(frame, **kwargs)
            _remaining(deadline)
            return _parse_regression(result, len(x_test), output, self._model.model_path)


def _parse_regression(raw: Any, rows: int, output: OutputSpec, model_version: str) -> BackendOutput:
    usage = BackendUsage(model_version=model_version)
    if output.type == "point":
        return Points(_point_values(raw, rows), usage)
    if output.type == "quantiles":
        return QuantileGrid(output.levels, _quantile_values(raw, rows, output.levels), usage)
    if not isinstance(raw, dict):
        raise MalformedUpstream("Prior Labs returned an invalid rich prediction")
    try:
        summary = RegressionSummary(
            means=_point_values(raw["mean"], rows),
            medians=_point_values(raw["median"], rows),
            modes=_point_values(raw["mode"], rows),
            levels=output.levels,
            quantiles=_quantile_values(raw["quantiles"], rows, output.levels),
            usage=usage,
        )
        if output.type == "summary":
            return summary
        borders = tuple(_as_finite_float(value) for value in _prediction_array(raw["borders"], 1))
        array = _prediction_array(raw["logits"], 2)
        if array.shape != (rows, len(borders) - 1):
            raise MalformedUpstream("Prior Labs returned invalid distribution dimensions")
        logits = tuple(
            tuple(None if value == float("-inf") else _as_finite_float(value) for value in row)
            for row in array
        )
        return RegressionDistribution(
            summary=summary,
            borders=borders,
            logits=logits,
            masked_logits=tuple(tuple(value is None for value in row) for row in logits),
        )
    except KeyError as error:
        raise MalformedUpstream("Prior Labs returned an incomplete rich prediction") from error


def _point_values(raw: Any, rows: int) -> tuple[float, ...]:
    array = _prediction_array(raw, 1)
    if array.shape != (rows,):
        raise MalformedUpstream("Prior Labs returned invalid point dimensions")
    return tuple(_as_finite_float(value) for value in array)


def _quantile_values(
    raw: Any, rows: int, levels: tuple[float, ...]
) -> tuple[tuple[float, ...], ...]:
    if not levels:
        if _prediction_array(raw, 1).size:
            raise MalformedUpstream("Prior Labs returned unexpected quantiles")
        return tuple(() for _ in range(rows))
    array = _prediction_array(raw, 2).T
    if array.shape != (rows, len(levels)):
        raise MalformedUpstream("Prior Labs returned an invalid quantile grid")
    return tuple(
        checked_quantile_row(tuple(_as_finite_float(value) for value in row)) for row in array
    )


@contextmanager
def _provider_errors() -> Iterator[None]:
    try:
        yield
    except FittedModelNotFoundError as error:
        raise ModelReferenceInvalid("provider fitted model has expired or been removed") from error
    except httpx.HTTPError as error:
        raise OutcomeUnknown("Prior Labs transport failure; outcome unknown") from error
    except (RetryableServerError, CappedRetryableServerError, RuntimeError) as error:
        raise OutcomeUnknown("Prior Labs request failed; outcome unknown") from error
    except ValueError as error:
        raise UpstreamRejected("Prior Labs rejected the data or configuration") from error


def _before_fit(options: dict, deadline: float) -> None:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise UpstreamTimeout("Prior Labs deadline reached before dispatch")
    options["client_options"].timeout = remaining


def _prediction_array(values: Any, dimensions: int) -> np.ndarray:
    try:
        array = np.asarray(values, dtype=object)
    except (TypeError, ValueError) as error:
        raise MalformedUpstream("Prior Labs returned an invalid prediction array") from error
    if array.ndim != dimensions:
        raise MalformedUpstream("Prior Labs returned invalid prediction dimensions")
    return array


def _as_finite_float(value: Any) -> float:
    if isinstance(value, bool | np.bool_) or not isinstance(
        value, int | float | np.integer | np.floating
    ):
        raise MalformedUpstream("Prior Labs prediction contains a non-numeric value")
    try:
        f = float(value)
    except (TypeError, ValueError) as exc:
        raise MalformedUpstream("Prior Labs prediction contains a non-numeric value") from exc
    if f != f or f in (float("inf"), float("-inf")):
        raise MalformedUpstream("Prior Labs prediction contains a non-finite value")
    return f
