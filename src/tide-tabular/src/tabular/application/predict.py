"""The one use case this service has: fit on the given rows, predict the rest.

Implements contracts v2 and v3 (`docs/api/tabular.v2.md`): bounded input,
deadline-limited chunks, context fallbacks, median quantiles, and dry runs.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import logging
import math
import statistics
import threading
import time
from collections import Counter
from collections.abc import Callable, Mapping
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import ExitStack
from dataclasses import asdict, dataclass, replace
from typing import Any, TypeVar, cast

from tabular.application.admission import AdmissionLimiter
from tabular.application.references import ReferenceCodec
from tabular.domain.capabilities import (
    FIT_OPTION_PARAMETERS,
    MODEL_OPTION_PARAMETERS,
    CapabilityCatalogue,
    catalogue_for,
)
from tabular.domain.errors import (
    ClassLimit,
    ConfigurationError,
    LimitExceeded,
    MalformedUpstream,
    ModelReferenceInvalid,
    OutcomeUnknown,
    Overloaded,
    TabularError,
    UnsupportedCapability,
    UpstreamError,
    UpstreamTimeout,
    ValidationFailure,
)
from tabular.domain.models import (
    BackendOutput,
    Capabilities,
    Cell,
    ClassProbas,
    ColumnSpec,
    DistributionChunk,
    Fallback,
    OutputSpec,
    Points,
    Prediction,
    PredictRequest,
    PredictRequestV3,
    QuantileGrid,
    ReferenceManifest,
    RegressionDistribution,
    RegressionSummary,
    TabularResult,
    Usage,
    canonical_class_label,
    checked_quantile_row,
)
from tabular.domain.placeholders import context_prediction
from tabular.domain.ports import (
    ClosableBackend,
    FittedCapacity,
    FittedDiagnostics,
    FittedModelBackend,
    FittedPredictor,
    ReferenceBackend,
    ReferenceTemplateBackend,
    RichOutputBackend,
    TabularBackend,
)

# Cost model of the TabPFN deployment (cost units per cell), from its price list.
CU_PER_CONTEXT_CELL = 1.05e-6
CU_PER_PREDICTED_CELL = 1.45e-4
MEDIAN = 0.5
OperationResult = TypeVar("OperationResult")


@dataclass(frozen=True)
class Limits:
    max_context_rows: int
    max_test_rows: int
    test_chunk_rows: int
    max_concurrent_calls: int
    max_columns: int = 500
    max_cells: int = 20_000_000
    max_levels: int = 99
    max_execution_cells: int = 20_000_000
    min_call_budget_s: float = 1.0


class PredictService:
    def __init__(
        self,
        backend: TabularBackend,
        limits: Limits,
        *,
        cache_identity: str | None = None,
        admission: AdmissionLimiter | None = None,
        dry_run_backend: TabularBackend | None = None,
    ) -> None:
        self._backend = backend
        self._dry_run_backend = dry_run_backend
        self.backend_identity = cache_identity
        self._limits = limits
        self._slots = (
            admission if admission is not None else AdmissionLimiter(limits.max_concurrent_calls)
        )
        self._executor = ThreadPoolExecutor(
            max_workers=limits.max_concurrent_calls, thread_name_prefix="tabular"
        )
        self._lifecycle = threading.Lock()
        self._closed = False

    def close(self) -> None:
        with self._lifecycle:
            if self._closed:
                return
            self._closed = True
            self._executor.shutdown(wait=True, cancel_futures=True)
            if isinstance(self._backend, ClosableBackend):
                self._backend.close()

    def _work_finished(self, future: Future[Any]) -> None:
        self._slots.release()
        error = None if future.cancelled() else future.exception()
        logging.getLogger("tabular").info(
            "provider work finished",
            extra={
                "fields": {
                    "backend": self._backend.name,
                    "outcome": "cancelled"
                    if future.cancelled()
                    else "failed"
                    if error
                    else "completed",
                    "code": getattr(error, "code", None),
                }
            },
        )

    @property
    def backend_name(self) -> str:
        return self._backend.name

    @property
    def capabilities(self) -> Capabilities:
        return self._backend.capabilities

    @property
    def limits(self) -> Limits:
        return self._limits

    @property
    def capability_digest(self) -> str:
        return self.catalogue.digest

    @property
    def catalogue(self) -> CapabilityCatalogue:
        return catalogue_for(
            self.backend_name,
            self.backend_identity,
            self.capabilities,
            rich=isinstance(self._backend, RichOutputBackend) and self._backend.rich_outputs,
            native=isinstance(self._backend, FittedModelBackend),
        )

    def plan_fingerprint(
        self, request: PredictRequestV3, *, manifest: Mapping[str, Any] | None = None
    ) -> str:
        return hashlib.sha256(
            json.dumps(
                {
                    "request": asdict(request),
                    "identity": self.backend_identity,
                    "capability_digest": self.capability_digest,
                    "local_limits": asdict(self.limits),
                    "fit_identity": {
                        key: value
                        for key, value in manifest.items()
                        if key not in ("expires_at", "version")
                    }
                    if manifest is not None
                    else None,
                },
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
        ).hexdigest()

    def run_v3(self, request: PredictRequestV3, *, deadline: float) -> TabularResult:
        dataset = self.prepare_v3(request)
        return self.run(dataset, deadline=deadline)

    def prepare_v3(self, request: PredictRequestV3) -> PredictRequest:
        if request.backend_key != self.backend_name or request.model_key != "default":
            raise UnsupportedCapability("requested provider/model is not enabled")
        if (request.model_options or request.fit_options) and not isinstance(
            self._backend, FittedModelBackend
        ):
            raise UnsupportedCapability("requested model/fit options are not supported")
        if (
            request.output_type in ("summary", "distribution") or request.statistic != "mean"
        ) and not (isinstance(self._backend, RichOutputBackend) and self._backend.rich_outputs):
            raise UnsupportedCapability("requested output is not supported")
        if request.output_type == "labels" and request.dataset.task != "classification":
            raise ValidationFailure("labels require classification")
        if request.output_type != "point" and request.statistic != "mean":
            raise ValidationFailure("statistic is only valid for point output")
        options = dict(request.model_options)
        fit = dict(request.fit_options)
        if options.keys() - set(MODEL_OPTION_PARAMETERS) or fit.keys() - set(FIT_OPTION_PARAMETERS):
            raise UnsupportedCapability("unknown model/fit option")
        inference = options.get("inference_config")
        if inference is not None and (
            not isinstance(inference, dict) or inference.keys() - {"SUBSAMPLE_SAMPLES"}
        ):
            raise UnsupportedCapability("unverified inference configuration")
        if request.dataset.task == "regression" and "balance_probabilities" in options:
            raise UnsupportedCapability("balance_probabilities requires classification")
        thinking = bool(fit.get("thinking_mode") or fit.get("thinking_effort"))
        group = fit.get("group_columns") or []
        if len(set(group)) != len(group):
            raise ValidationFailure("group column names must be unique")
        time_column = fit.get("time_column")
        grouped_time = fit.get("grouped_time_column")
        named = [*group, *[name for name in (time_column, grouped_time) if name is not None]]
        if (named or fit.get("fit_timeout") or fit.get("thinking_metric")) and not thinking:
            raise UnsupportedCapability("group/time and thinking options require thinking mode")
        if (group and time_column) or (grouped_time and not group):
            raise ValidationFailure("invalid group/time column combination")
        if any(name not in {column.name for column in request.dataset.columns} for name in named):
            raise ValidationFailure("fit metadata names an unknown column")
        if fit.get("fit_mode") == "fit_with_cache" and thinking:
            raise UnsupportedCapability("managed KV cache cannot be combined with thinking")
        dataset = replace(
            request.dataset,
            contract_version=3,
            model_options=request.model_options,
            fit_options=request.fit_options,
            output=OutputSpec(
                "probas" if request.output_type == "labels" else request.output_type,
                request.dataset.output.levels,
                request.statistic,
            ),
        )
        return dataset

    def _model_operation(
        self, operation: Callable[[], OperationResult], *, deadline: float
    ) -> OperationResult:
        with ExitStack() as admission:
            with self._lifecycle:
                if self._closed:
                    raise ConfigurationError("prediction service is closed")
                if deadline <= time.monotonic():
                    raise UpstreamTimeout("deadline reached before model operation")
                if not self._slots.acquire(blocking=False):
                    raise Overloaded("all backend slots are busy")
            admission.callback(self._slots.release)
            context = contextvars.copy_context()
            with self._lifecycle:
                if self._closed:
                    raise ConfigurationError("prediction service is closed")
                future = self._executor.submit(context.run, operation)
                admission.pop_all()
                future.add_done_callback(lambda done: context.copy().run(self._work_finished, done))
            try:
                return future.result(timeout=max(0, deadline - time.monotonic()))
            except TimeoutError as error:
                future.cancel()
                raise OutcomeUnknown(
                    "model operation exceeded deadline; outcome unknown"
                ) from error

    def fit_v3(
        self,
        request: PredictRequestV3,
        *,
        deadline: float,
        reference_codec: ReferenceCodec | None = None,
    ) -> ReferenceManifest:
        def operation() -> ReferenceManifest:
            dataset = self.prepare_v3(request)
            self._validate(dataset)
            if not isinstance(self._backend, FittedModelBackend):
                raise UnsupportedCapability("native model fits are not supported")
            cells = len(dataset.x_train) * (len(dataset.columns) + 1)
            if cells > self.limits.max_execution_cells:
                raise LimitExceeded("native fit exceeds local execution capacity")
            if deadline <= time.monotonic():
                raise UpstreamTimeout("deadline reached before native fit preprocessing")
            x_train = [list(row) for row in dataset.x_train]
            y_train: list[Cell] = (
                [canonical_class_label(target) for target in dataset.y_train]
                if dataset.task == "classification"
                else list(dataset.y_train)
            )
            manifest: ReferenceManifest = {
                "backendKey": request.backend_key,
                "modelKey": request.model_key,
                "configuration_identity": self.backend_identity,
                "task": dataset.task,
                "columns": [asdict(column) for column in dataset.columns],
                "feature_indices": list(range(len(dataset.columns))),
                "record": {
                    "tabpfn_client_version": "0.6.0",
                    "task": dataset.task,
                    "model_id": "00000000-0000-0000-0000-000000000000",
                    "params": {},
                    "n_train_rows": len(y_train),
                    "classes": None,
                },
                "training_fingerprint": hashlib.sha256(
                    json.dumps(
                        {"x_train": dataset.x_train, "y_train": dataset.y_train},
                        sort_keys=True,
                        separators=(",", ":"),
                        allow_nan=False,
                    ).encode()
                ).hexdigest(),
                "model_options": dict(dataset.model_options),
                "fit_options": dict(dataset.fit_options),
            }
            if reference_codec is not None:
                if not isinstance(self._backend, ReferenceTemplateBackend):
                    raise UnsupportedCapability("portable model references are not supported")
                manifest["record"] = self._backend.reference_template(
                    task=dataset.task,
                    columns=dataset.columns,
                    y_train=y_train,
                    model_options=dict(dataset.model_options),
                    fit_options=dict(dataset.fit_options),
                )
                reference_codec.preflight(manifest)
            remaining = deadline - time.monotonic()
            if remaining <= 0 or remaining < self.limits.min_call_budget_s:
                raise UpstreamTimeout("deadline reached before native fit")
            fitted = self._backend.fit(
                task=dataset.task,
                columns=dataset.columns,
                x_train=x_train,
                y_train=y_train,
                model_options=dict(dataset.model_options),
                fit_options=dict(dataset.fit_options),
                timeout_s=remaining,
            )
            if time.monotonic() >= deadline:
                raise OutcomeUnknown("fit completed after deadline; outcome unknown")
            manifest["record"] = fitted.export()
            if reference_codec is not None:
                reference_codec.validate_export(manifest)
            return manifest

        return self._model_operation(operation, deadline=deadline)

    def predict_reference_v3(
        self, request: PredictRequestV3, manifest: Mapping[str, Any], *, deadline: float
    ) -> TabularResult:
        def operation() -> TabularResult:
            started = time.perf_counter()
            dataset = self.prepare_v3(request)
            if request.model_options or request.fit_options:
                raise ModelReferenceInvalid("model reference options cannot be changed")
            if dataset.mode == "dry_run":
                raise UnsupportedCapability("model-reference dry runs are not supported")
            if manifest.get("task") != dataset.task or manifest.get("columns") != [
                asdict(column) for column in dataset.columns
            ]:
                raise ModelReferenceInvalid("model reference schema/task does not match")
            if not isinstance(self._backend, ReferenceBackend):
                raise UnsupportedCapability("model reference import is not supported")
            if dataset.x_train or dataset.y_train:
                raise ModelReferenceInvalid("model reference cannot be combined with training rows")
            width = len(dataset.columns)
            names = [column.name for column in dataset.columns]
            if not width or any(not name for name in names) or len(set(names)) != width:
                raise ModelReferenceInvalid("model reference has invalid schema")
            if len(dataset.x_test) > self.limits.max_test_rows or width > self.limits.max_columns:
                raise LimitExceeded("model prediction exceeds local row/column limits")
            if not dataset.x_test or len(dataset.keys) != len(dataset.x_test):
                raise ValidationFailure("keys must have one value per non-empty x_test row")
            if any(not key for key in dataset.keys) or len(set(dataset.keys)) != len(dataset.keys):
                raise ValidationFailure("keys must be unique and non-empty")
            if len(dataset.x_test) * width > self.limits.max_cells:
                raise LimitExceeded("model prediction exceeds the local cell limit")
            for row in dataset.x_test:
                if len(row) != width:
                    raise ValidationFailure("test row width does not match model schema")
                for column, value in zip(dataset.columns, row, strict=True):
                    _check_cell(column, value)
            record = manifest["record"]
            train_rows = record.get("n_train_rows")
            if (
                isinstance(train_rows, bool)
                or not isinstance(train_rows, int)
                or not 0 < train_rows <= self.limits.max_context_rows
            ):
                raise ModelReferenceInvalid("model reference has invalid training dimensions")
            if len(dataset.x_test) * width > self.limits.max_execution_cells:
                raise LimitExceeded("model prediction exceeds local execution capacity")
            dataset = replace(dataset, y_train=tuple(record.get("classes") or ()))
            self._validate_output(dataset)
            remaining = deadline - time.monotonic()
            if remaining <= 0 or remaining < self.limits.min_call_budget_s:
                raise UpstreamTimeout("deadline reached before reference restoration")
            fitted = self._backend.restore(
                record,
                task=dataset.task,
                columns=dataset.columns,
                timeout_s=remaining,
            )
            predictions, classes, calls, reported, distributions, diagnostics = (
                self._predict_chunks(
                    dataset,
                    dataset.columns,
                    [],
                    [list(row) for row in dataset.x_test],
                    _with_median(dataset.output),
                    deadline,
                    fitted=fitted,
                )
            )
            return TabularResult(
                task=dataset.task,
                output_type=dataset.output.type,
                predictions=tuple(predictions),
                classes=classes,
                levels=dataset.output.levels
                if dataset.output.type in ("quantiles", "summary", "distribution")
                else None,
                fallback=None,
                dropped_columns=(),
                placeholder=False,
                usage=Usage(
                    backend=self.backend_name,
                    calls=calls,
                    context_cells=0,
                    predicted_cells=len(dataset.x_test) * width,
                    cost_units=round(CU_PER_PREDICTED_CELL * len(dataset.x_test) * width, 10),
                    effective_feature_count=width,
                    num_cells=reported[0],
                    num_predictions=reported[1],
                    model_version=reported[2],
                ),
                train_rows=train_rows,
                elapsed_ms=(time.perf_counter() - started) * 1000,
                distributions=distributions,
                diagnostics={**diagnostics, "fit_strategy": "reference_reuse", "fit_calls": 0},
            )

        return self._model_operation(operation, deadline=deadline)

    def run(self, request: PredictRequest, *, deadline: float) -> TabularResult:
        """Wait for admitted work only until the monotonic deadline; work may outlive it."""
        if self._closed:
            raise ConfigurationError("prediction service is closed")
        if deadline <= time.monotonic():
            raise UpstreamTimeout("deadline reached before all test rows were predicted")
        with ExitStack() as admission:
            with self._lifecycle:
                if self._closed:
                    raise ConfigurationError("prediction service is closed")
                if not self._slots.acquire(blocking=False):
                    raise Overloaded("all backend slots are busy")
            admission.callback(self._slots.release)
            return self._run_admitted(request, deadline=deadline, admission=admission)

    def _run_admitted(
        self, request: PredictRequest, *, deadline: float, admission: ExitStack
    ) -> TabularResult:
        self._validate(request)
        if deadline <= time.monotonic():
            raise UpstreamTimeout("deadline reached before feature scanning")
        started = time.perf_counter()
        keep = _varying(request)
        if request.contract_version == 3:
            metadata = dict(request.fit_options)
            required = set(metadata.get("group_columns") or [])
            required.update(
                name
                for name in (metadata.get("time_column"), metadata.get("grouped_time_column"))
                if name is not None
            )
            keep = [
                index
                for index, column in enumerate(request.columns)
                if index in keep or column.name in required
            ]
        rich = request.output.type in ("summary", "distribution")
        if rich and not keep:
            keep = list(range(len(request.columns)))
        dropped = tuple(c.name for i, c in enumerate(request.columns) if i not in keep)
        columns = tuple(request.columns[i] for i in keep)
        if deadline <= time.monotonic():
            raise UpstreamTimeout("deadline reached before row preprocessing")
        x_train = [[row[i] for i in keep] for row in request.x_train]
        x_test = [[row[i] for i in keep] for row in request.x_test]
        call_output = _with_median(request.output)
        fallback = None if rich else _fallback(request, bool(keep))
        classes: tuple[str, ...] | None = None
        reported: tuple[int | None, int | None, str | None] = (None, None, None)
        distributions: tuple[DistributionChunk, ...] = ()
        diagnostics: dict[str, Any] = {}
        planned_calls = 0 if fallback else math.ceil(len(x_test) / self._chunk_rows())
        native = (
            request.contract_version == 3
            and request.mode != "dry_run"
            and isinstance(self._backend, FittedModelBackend)
        )
        width = len(columns)
        execution_cells = (
            (len(x_train) * (width + 1) * (1 if native else planned_calls) + len(x_test) * width)
            if planned_calls
            else 0
        )
        if execution_cells > self._limits.max_execution_cells:
            raise LimitExceeded(
                f"{execution_cells} execution cells, "
                f"at most {self._limits.max_execution_cells} are allowed"
            )

        if fallback:
            predictions, classes = _context_answer(request)
            calls = 0
        elif request.mode == "dry_run" and not rich:
            predictions, classes = _context_answer(request)
            calls = planned_calls
        else:
            if (
                deadline - time.monotonic() <= 0
                or deadline - time.monotonic() < self._limits.min_call_budget_s
            ):
                raise UpstreamTimeout("deadline reached before all test rows were predicted")
            context = contextvars.copy_context()
            with self._lifecycle:
                if self._closed:
                    raise ConfigurationError("prediction service is closed")
                future = self._executor.submit(
                    context.run,
                    self._predict_chunks,
                    request,
                    columns,
                    x_train,
                    x_test,
                    call_output,
                    deadline,
                )
                admission.pop_all()
                future.add_done_callback(lambda done: context.copy().run(self._work_finished, done))
            try:
                predictions, classes, calls, reported, distributions, diagnostics = future.result(
                    timeout=max(0, deadline - time.monotonic())
                )
            except TimeoutError as error:
                future.cancel()
                logging.getLogger("tabular").warning(
                    "caller deadline reached; provider outcome unknown"
                )
                raise OutcomeUnknown(
                    "provider work exceeded the caller deadline; outcome unknown"
                ) from error

        width = len(columns)
        context_cells = (
            len(request.x_train) * (width + 1) * (1 if native and calls else calls) if width else 0
        )
        predicted_cells = len(request.x_test) * width if calls else 0
        backend_cells = reported[0]
        usage = Usage(
            backend=self._backend.name,
            calls=calls,
            context_cells=context_cells,
            predicted_cells=predicted_cells,
            cost_units=round(
                CU_PER_CONTEXT_CELL * context_cells + CU_PER_PREDICTED_CELL * predicted_cells, 10
            ),
            effective_feature_count=width,
            num_cells=backend_cells,
            num_predictions=reported[1] if backend_cells is not None else None,
            model_version=reported[2],
        )
        return TabularResult(
            task=request.task,
            output_type=request.output.type,
            predictions=tuple(predictions),
            classes=classes,
            levels=request.output.levels
            if request.output.type in ("quantiles", "summary", "distribution")
            else None,
            fallback=fallback,
            dropped_columns=dropped,
            placeholder=request.mode == "dry_run" and not fallback,
            usage=usage,
            train_rows=len(request.x_train),
            elapsed_ms=(time.perf_counter() - started) * 1000,
            distributions=distributions,
            diagnostics=diagnostics,
        )

    def _chunk_rows(self) -> int:
        return max(1, min(self._limits.test_chunk_rows, self._backend.capabilities.max_test_batch))

    def _predict_chunks(
        self,
        request: PredictRequest,
        columns: tuple[ColumnSpec, ...],
        x_train: list[list[Any]],
        x_test: list[list[Any]],
        output: OutputSpec,
        deadline: float,
        *,
        fitted: FittedPredictor | None = None,
    ) -> tuple[
        list[Prediction],
        tuple[str, ...] | None,
        int,
        tuple[int | None, int | None, str | None],
        tuple[DistributionChunk, ...],
        dict[str, Any],
    ]:
        size = self._chunk_rows()
        y_train: list[Cell] = (
            [canonical_class_label(target) for target in request.y_train]
            if request.task == "classification" and request.contract_version == 3
            else list(request.y_train)
        )
        predictions: list[Prediction] = []
        classes: tuple[str, ...] | None = None
        calls = 0
        cells: int | None = 0
        preds: int | None = 0
        versions: set[str | None] = set()
        distributions: list[DistributionChunk] = []
        if (
            fitted is None
            and request.contract_version == 3
            and request.mode != "dry_run"
            and isinstance(self._backend, FittedModelBackend)
        ):
            remaining = deadline - time.monotonic()
            if remaining < self._limits.min_call_budget_s or remaining <= 0:
                raise UpstreamTimeout("deadline reached before fit")
            fitted = self._backend.fit(
                task=request.task,
                columns=columns,
                x_train=x_train,
                y_train=y_train,
                model_options=dict(request.model_options),
                fit_options=dict(request.fit_options),
                timeout_s=remaining,
            )
        if fitted is not None:
            batch_limit = fitted.batch_limit(output) if isinstance(fitted, FittedCapacity) else None
            if batch_limit is not None:
                if (
                    isinstance(batch_limit, bool)
                    or not isinstance(batch_limit, int)
                    or batch_limit <= 0
                ):
                    raise MalformedUpstream("backend returned invalid prediction capacity")
                size = min(size, batch_limit)
        for start in range(0, len(x_test), size):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or remaining < self._limits.min_call_budget_s:
                if calls or fitted is not None:
                    raise OutcomeUnknown("deadline reached after partial provider work")
                raise UpstreamTimeout("deadline reached before all test rows were predicted")
            keys = request.keys[start : start + size]
            chunk = x_test[start : start + size]
            try:
                backend = self._backend
                if request.mode == "dry_run":
                    if self._dry_run_backend is None:
                        result = context_prediction(request.task, y_train, len(chunk), output)
                    else:
                        result = self._dry_run_backend.fit_predict(
                            task=request.task,
                            columns=columns,
                            x_train=x_train,
                            y_train=y_train,
                            x_test=chunk,
                            output=output,
                            timeout_s=remaining,
                        )
                elif request.contract_version == 3 and isinstance(backend, FittedModelBackend):
                    if fitted is None:
                        fitted = backend.fit(
                            task=request.task,
                            columns=columns,
                            x_train=x_train,
                            y_train=y_train,
                            model_options=dict(request.model_options),
                            fit_options=dict(request.fit_options),
                            timeout_s=remaining,
                        )
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise OutcomeUnknown("deadline reached after fit")
                    result = fitted.predict(chunk, output=output, timeout_s=remaining)
                else:
                    result = backend.fit_predict(
                        task=request.task,
                        columns=columns,
                        x_train=x_train,
                        y_train=y_train,
                        x_test=chunk,
                        output=output,
                        timeout_s=remaining,
                    )
            except TabularError as error:
                if (calls or fitted is not None) and error.retryable:
                    raise OutcomeUnknown(
                        "provider failure after partial work; do not replay"
                    ) from error
                raise
            if time.monotonic() >= deadline:
                raise OutcomeUnknown("provider completed after the caller deadline")
            calls += 1
            chunk_predictions, chunk_classes = _to_predictions(keys, result, request.output)
            if request.contract_version == 3 and chunk_classes is not None:
                if set(chunk_classes) != {
                    canonical_class_label(value) for value in request.y_train
                }:
                    raise MalformedUpstream("backend returned classes outside the training target")
            if classes is not None and chunk_classes != classes:
                raise MalformedUpstream("backend returned different classes for one context")
            classes = chunk_classes
            predictions.extend(chunk_predictions)
            if isinstance(result, RegressionDistribution):
                distributions.append(DistributionChunk(keys, result))
            cells = _add(cells, result.usage.num_cells)
            preds = _add(preds, result.usage.num_predictions)
            versions.add(result.usage.model_version)
        version = next(iter(versions)) if len(versions) == 1 else None
        diagnostics: dict[str, Any] = (
            fitted.describe() if isinstance(fitted, FittedDiagnostics) else {}
        )
        diagnostics.update(
            fit_strategy="native_fit_once" if fitted is not None else "stateless_fit_predict",
            fit_calls=1 if fitted is not None else calls,
            effective_chunk_rows=size,
        )
        return (
            predictions,
            classes,
            calls,
            (cells, preds, version),
            tuple(distributions),
            diagnostics,
        )

    def _validate(self, request: PredictRequest) -> None:
        limits = self._limits
        width = len(request.columns)
        if not width:
            raise ValidationFailure("columns must not be empty")
        names = [c.name for c in request.columns]
        if any(not n for n in names) or len(set(names)) != len(names):
            raise ValidationFailure("column names must be unique and non-empty")
        if width > limits.max_columns:
            raise LimitExceeded(f"{width} columns, at most {limits.max_columns} are allowed")
        if not request.x_train:
            raise ValidationFailure("x_train must not be empty")
        if len(request.x_train) > limits.max_context_rows:
            raise LimitExceeded(
                f"x_train has {len(request.x_train)} rows, "
                f"at most {limits.max_context_rows} are allowed"
            )
        if len(request.y_train) != len(request.x_train):
            raise ValidationFailure("y_train must have one value per x_train row")
        if not request.x_test:
            raise ValidationFailure("x_test must not be empty")
        if len(request.x_test) > limits.max_test_rows:
            raise LimitExceeded(
                f"x_test has {len(request.x_test)} rows, at most {limits.max_test_rows} are allowed"
            )
        cells = (len(request.x_train) + len(request.x_test)) * width
        if cells > limits.max_cells:
            raise LimitExceeded(f"{cells} cells, at most {limits.max_cells} are allowed")
        if len(request.keys) != len(request.x_test):
            raise ValidationFailure("keys must have one value per x_test row")
        if any(not k for k in request.keys) or len(set(request.keys)) != len(request.keys):
            raise ValidationFailure("keys must be unique and non-empty")
        if any(len(row) != width for row in (*request.x_train, *request.x_test)):
            raise ValidationFailure(f"every row must have {width} values, one per column")
        for row in (*request.x_train, *request.x_test):
            for column, value in zip(request.columns, row, strict=True):
                _check_cell(column, value)
        if any(y is None for y in request.y_train):
            raise ValidationFailure("y_train must not contain nulls")
        self._validate_output(request)

    def _validate_output(self, request: PredictRequest) -> None:
        output = request.output
        if (output.type == "probas") != (request.task == "classification"):
            raise ValidationFailure(
                f"output {output.type!r} does not fit task {request.task!r} "
                "(probas for classification, point or quantiles for regression)"
            )
        if request.task == "classification":
            labels = {canonical_class_label(target) for target in request.y_train}
            if not labels:
                raise ValidationFailure("classification needs at least one class in y_train")
            classes = len(labels)
            if classes > self._backend.capabilities.max_classes:
                raise ClassLimit(
                    f"{classes} classes, the backend supports at most "
                    f"{self._backend.capabilities.max_classes}"
                )
        else:
            if any(isinstance(y, bool) or not _finite_number(y) for y in request.y_train):
                raise ValidationFailure("regression y_train must be finite numbers")
        if output.type in ("quantiles", "summary", "distribution"):
            levels = output.levels
            if not levels and output.type == "quantiles":
                raise ValidationFailure("quantiles need at least one level")
            if len(levels) > self._limits.max_levels:
                raise ValidationFailure(f"at most {self._limits.max_levels} levels are allowed")
            if any(not (0 < lv < 1) for lv in levels):
                raise ValidationFailure("levels must lie strictly between 0 and 1")
            if list(levels) != sorted(set(levels)):
                raise ValidationFailure("levels must be sorted and unique")
        elif output.levels:
            raise ValidationFailure("levels require quantiles, summary or distribution")


def _add(total: int | None, part: int | None) -> int | None:
    """Sum of backend-reported counts; unknown as soon as one chunk is silent."""
    return None if total is None or part is None else total + part


def _finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    return math.isfinite(value)


def _check_cell(column: ColumnSpec, value: Any) -> None:
    if value is None:
        return
    if column.kind == "numeric":
        if not _finite_number(value):
            raise ValidationFailure(f"column {column.name}: numeric cells must be finite numbers")
    elif column.kind == "text":
        if not isinstance(value, str):
            raise ValidationFailure(f"column {column.name}: text cells must be strings")
    elif isinstance(value, float) and not math.isfinite(value):
        raise ValidationFailure(f"column {column.name}: non-finite value")


def _varying(request: PredictRequest) -> list[int]:
    """Indexes of columns with more than one distinct value in x_train."""
    return [
        i for i in range(len(request.columns)) if len({repr(row[i]) for row in request.x_train}) > 1
    ]


def _fallback(request: PredictRequest, any_varying: bool) -> Fallback | None:
    if request.task == "classification":
        single = len({canonical_class_label(t) for t in request.y_train}) < 2
        return None if any_varying and not single else "context_distribution"
    constant = len({float(cast(int | float, t)) for t in request.y_train}) < 2
    if not any_varying or len(request.x_train) < 2 or constant:
        return "context_quantiles" if request.output.type == "quantiles" else "context_distribution"
    return None


def _with_median(output: OutputSpec) -> OutputSpec:
    if output.type != "quantiles" or MEDIAN in output.levels:
        return output
    return replace(output, levels=tuple(sorted({*output.levels, MEDIAN})))


def _quantile(sorted_values: list[float], level: float) -> float:
    """Linear interpolation between order statistics (numpy's default)."""
    pos = level * (len(sorted_values) - 1)
    lo, hi = math.floor(pos), math.ceil(pos)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def _context_answer(request: PredictRequest) -> tuple[list[Prediction], tuple[str, ...] | None]:
    """The same answer for every test row, from the training targets alone."""
    keys = request.keys
    if request.task == "classification":
        counts = Counter(canonical_class_label(target) for target in request.y_train)
        classes = tuple(sorted(counts))
        total = sum(counts.values())
        probas = tuple(counts[c] / total for c in classes)
        majority = max(classes, key=lambda c: (counts[c], c))
        return [Prediction(k, majority, probabilities=probas) for k in keys], classes
    ys = sorted(float(cast(int | float, target)) for target in request.y_train)
    if request.output.type == "quantiles":
        q = tuple(_quantile(ys, lv) for lv in request.output.levels)
        median = _quantile(ys, MEDIAN)
        return [Prediction(k, median, quantiles=q) for k in keys], None
    statistics_by_name: dict[str, Callable[[list[float]], float]] = {
        "mean": statistics.fmean,
        "median": statistics.median,
        "mode": statistics.mode,
    }
    point = statistics_by_name[request.output.statistic](ys)
    return [Prediction(k, point) for k in keys], None


def _to_predictions(
    keys: tuple[str, ...], output: BackendOutput, requested: OutputSpec
) -> tuple[list[Prediction], tuple[str, ...] | None]:
    expected_type = {
        "probas": ClassProbas,
        "point": Points,
        "quantiles": QuantileGrid,
        "summary": RegressionSummary,
        "distribution": RegressionDistribution,
    }[requested.type]
    if not isinstance(output, expected_type):
        raise MalformedUpstream("backend returned an unexpected output type")
    for count in (output.usage.num_cells, output.usage.num_predictions):
        if count is not None and (
            isinstance(count, bool) or not isinstance(count, int) or count < 0
        ):
            raise MalformedUpstream("backend returned invalid usage counts")
    if isinstance(output, ClassProbas):
        if (
            not output.classes
            or any(not isinstance(label, str) or not label for label in output.classes)
            or len(set(output.classes)) != len(output.classes)
        ):
            raise MalformedUpstream("backend returned invalid classes")
        if len(output.scores) != len(keys):
            raise MalformedUpstream("backend returned a different number of rows")
        for scores in output.scores:
            if (
                len(scores) != len(output.classes)
                or any(not _finite_number(score) or not 0 <= score <= 1 for score in scores)
                or not math.isclose(sum(scores), 1, rel_tol=0, abs_tol=1e-6)
            ):
                raise MalformedUpstream("backend returned invalid probabilities")
        return [
            Prediction(
                row_key=key,
                value=output.classes[max(range(len(scores)), key=lambda i: scores[i])],
                probabilities=scores,
            )
            for key, scores in zip(keys, output.scores, strict=True)
        ], output.classes
    if isinstance(output, Points):
        if len(output.points) != len(keys):
            raise MalformedUpstream("backend returned a different number of rows")
        if any(not _finite_number(point) for point in output.points):
            raise MalformedUpstream("backend returned non-finite points")
        points = zip(keys, output.points, strict=True)
        return [Prediction(key, point) for key, point in points], None
    if isinstance(output, QuantileGrid):
        if len(output.values) != len(keys):
            raise MalformedUpstream("backend returned a different number of rows")
        if output.levels != _with_median(requested).levels:
            raise MalformedUpstream("backend returned other quantile levels than requested")
        index = {lv: i for i, lv in enumerate(output.levels)}
        if MEDIAN not in index or any(lv not in index for lv in requested.levels):
            raise UpstreamError("backend returned other quantile levels than requested")
        predictions = []
        for key, row in zip(keys, output.values, strict=True):
            if len(row) != len(output.levels):
                raise MalformedUpstream("backend returned a different number of quantiles")
            checked_quantile_row(row)
            predictions.append(
                Prediction(
                    key,
                    row[index[MEDIAN]],
                    quantiles=tuple(row[index[lv]] for lv in requested.levels),
                )
            )
        return predictions, None
    if isinstance(output, RegressionSummary | RegressionDistribution):
        summary = output.summary if isinstance(output, RegressionDistribution) else output
        if summary.levels != requested.levels:
            raise MalformedUpstream("backend returned other summary levels than requested")
        for values in (summary.means, summary.medians, summary.modes):
            if len(values) != len(keys) or any(not _finite_number(value) for value in values):
                raise MalformedUpstream("backend returned invalid summary values")
        if len(summary.quantiles) != len(keys):
            raise MalformedUpstream("backend returned invalid summary row count")
        for row in summary.quantiles:
            if len(row) != len(summary.levels):
                raise MalformedUpstream("backend returned invalid summary quantile count")
            checked_quantile_row(row)
        if isinstance(output, RegressionDistribution):
            if output.coordinates != "target" or output.tails not in (
                "full_support",
                "bounded_synthetic",
            ):
                raise MalformedUpstream("backend returned invalid distribution conventions")
            width = len(output.borders) - 1
            if (
                width < 1
                or any(not _finite_number(border) for border in output.borders)
                or any(
                    left >= right
                    for left, right in zip(output.borders, output.borders[1:], strict=False)
                )
                or len(output.logits) != len(keys)
                or len(output.masked_logits) != len(keys)
            ):
                raise MalformedUpstream("backend returned invalid distribution axes")
            for logits, masks in zip(output.logits, output.masked_logits, strict=True):
                if len(logits) != width or len(masks) != width or all(masks):
                    raise MalformedUpstream("backend returned invalid distribution dimensions")
                if any(
                    not isinstance(mask, bool)
                    or (value is not None if mask else not _finite_number(value))
                    for value, mask in zip(logits, masks, strict=True)
                ):
                    raise MalformedUpstream("backend returned invalid distribution logits")
        return [
            Prediction(
                key,
                summary.means[index],
                quantiles=summary.quantiles[index],
                mean=summary.means[index],
                median=summary.medians[index],
                mode=summary.modes[index],
            )
            for index, key in enumerate(keys)
        ], None
    raise ValidationFailure(f"unknown backend output type: {type(output)!r}")
