"""SAP AI Core adapter for the managed TabPFN deployment (TabPFN-3.5 Plus).

Maps the columnar `/predict` contract, including levels-first quantiles, and
never replays inference after an uncertain outcome.
"""

from __future__ import annotations

import math
import threading
import time
from typing import Any

import httpx

from tabular.domain.errors import (
    ConfigurationError,
    MalformedUpstream,
    OutcomeUnknown,
    UpstreamError,
    UpstreamRejected,
    UpstreamTimeout,
)
from tabular.domain.models import (
    BackendOutput,
    BackendUsage,
    Capabilities,
    ClassProbas,
    ColumnSpec,
    OutputSpec,
    Points,
    QuantileGrid,
    Task,
    checked_quantile_row,
)
from tabular.settings import AiCoreConfig

TARGET = "target"
TOKEN_MARGIN_S = 60.0
OUTPUT_TYPES = {"probas": "probas", "point": "mean", "quantiles": "quantiles"}


class AiCoreBackend:
    """Thread-safe `TabularBackend` backed by a managed AI Core deployment."""

    name = "aicore"

    def __init__(
        self,
        settings: AiCoreConfig,
        http: httpx.Client | None = None,
        sleep=time.sleep,
    ) -> None:
        self._s = settings
        self.capabilities = Capabilities(settings.max_test_batch, settings.max_classes)
        self._http = http or httpx.Client()
        self._owns_http = http is None
        self._sleep = sleep
        self._lock = threading.Lock()
        self._token: tuple[str, float] | None = None
        self._pace_lock = threading.Lock()
        self._next_call = 0.0

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    # ------------------------------------------------------------ call

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
        body = payload(task, columns, x_train, y_train, x_test, output)
        response = self._post(body, deadline=deadline)
        usage = _usage(response)
        if output.type == "probas":
            classes, scores = parse_probas(response, len(x_test))
            return ClassProbas(classes=classes, scores=scores, usage=usage)
        if output.type == "quantiles":
            values = parse_quantiles(response, len(output.levels), len(x_test))
            return QuantileGrid(levels=output.levels, values=values, usage=usage)
        return Points(points=parse_points(response, len(x_test)), usage=usage)

    # ------------------------------------------------------------ auth

    def _config(self) -> tuple[str, str]:
        return self._s.deployment_url, self._s.auth_url

    def _bearer(self, auth_url: str, *, refresh: bool, deadline: float) -> str:
        if not self._lock.acquire(timeout=max(0, deadline - time.monotonic())):
            raise UpstreamTimeout("AI Core token lock: deadline reached")
        try:
            now = time.monotonic()
            if not refresh and self._token and self._token[1] > now:
                return self._token[0]
            remaining = deadline - now
            if remaining <= 0:
                raise UpstreamTimeout("AI Core token: deadline reached")
            try:
                resp = self._http.post(
                    auth_url,
                    data={"grant_type": "client_credentials"},
                    auth=(self._s.client_id, self._s.client_secret),
                    timeout=min(30.0, remaining),
                )
            except httpx.TimeoutException as exc:
                raise UpstreamTimeout("AI Core token request timed out") from exc
            except httpx.HTTPError as exc:
                raise UpstreamError(f"AI Core token transport error: {type(exc).__name__}") from exc
            if resp.status_code != 200:
                if resp.status_code in (400, 401, 403):
                    raise ConfigurationError(
                        f"AI Core token request returned HTTP {resp.status_code}"
                    )
                raise UpstreamError(f"AI Core token request returned HTTP {resp.status_code}")
            try:
                body = resp.json()
            except ValueError as error:
                raise ConfigurationError("AI Core token response is not JSON") from error
            token = body.get("access_token") if isinstance(body, dict) else None
            if not isinstance(token, str) or not token:
                raise UpstreamError("AI Core token response has no access_token")
            ttl = float(body.get("expires_in", 300)) - TOKEN_MARGIN_S
            self._token = (token, now + max(ttl, 0.0))
            return token
        finally:
            self._lock.release()

    # ------------------------------------------------------------ transport

    def _pace(self, deadline: float) -> None:
        with self._pace_lock:
            now = time.monotonic()
            delay = self._next_call - now
            if max(now, self._next_call) >= deadline:
                raise UpstreamTimeout("AI Core pacing: deadline reached")
            self._next_call = max(now, self._next_call) + self._s.min_call_interval_seconds
        if delay > 0:
            self._sleep(delay)

    def _post(self, body: dict[str, Any], *, deadline: float) -> Any:
        url, auth_url = self._config()
        token = self._bearer(auth_url, refresh=False, deadline=deadline)
        self._pace(deadline)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise UpstreamTimeout("AI Core /predict: deadline reached")
        headers = {
            "Authorization": f"Bearer {token}",
            "AI-Resource-Group": self._s.resource_group,
            "Content-Type": "application/json",
        }
        try:
            resp = self._http.post(f"{url}/predict", headers=headers, json=body, timeout=remaining)
        except httpx.HTTPError as error:
            raise OutcomeUnknown(
                f"AI Core /predict transport error: {type(error).__name__}; outcome unknown"
            ) from error
        if resp.status_code in (401, 403):
            with self._lock:
                self._token = None
        if resp.status_code == 200:
            try:
                return resp.json()
            except ValueError as error:
                raise MalformedUpstream("AI Core response is not JSON") from error
        message = f"AI Core /predict returned HTTP {resp.status_code}"
        if resp.status_code == 429 or resp.status_code >= 500:
            raise OutcomeUnknown(f"{message}; outcome unknown")
        raise UpstreamRejected(message)


# ---------------------------------------------------------------- payload


def _columnar(columns: tuple[ColumnSpec, ...], rows: list[list[Any]]) -> dict[str, list[Any]]:
    return {c.name: [row[i] for row in rows] for i, c in enumerate(columns)}


def payload(
    task: Task,
    columns: tuple[ColumnSpec, ...],
    x_train: list[list[Any]],
    y_train: list[Any],
    x_test: list[list[Any]],
    output: OutputSpec,
) -> dict[str, Any]:
    params: dict[str, Any] = {"output_type": OUTPUT_TYPES[output.type]}
    if output.type == "quantiles":
        params["quantiles"] = list(output.levels)
    config: dict[str, Any] = {"task": task, "predict_params": params}
    categorical = [i for i, c in enumerate(columns) if c.kind == "categorical"]
    if categorical:
        config["tabpfn_config"] = {"categorical_features_indices": categorical}
    return {
        "x_train": _columnar(columns, x_train),
        "y_train": {TARGET: list(y_train)},
        "x_test": _columnar(columns, x_test),
        "task_config": config,
    }


# ---------------------------------------------------------------- parsers


def _finite(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise MalformedUpstream("AI Core prediction contains a non-numeric value")
    try:
        f = float(value)
    except (TypeError, ValueError) as exc:
        raise MalformedUpstream("AI Core prediction contains a non-numeric value") from exc
    if not math.isfinite(f):
        raise MalformedUpstream("AI Core prediction contains a non-finite value")
    return f


def _object(response: Any) -> dict[str, Any]:
    if not isinstance(response, dict):
        raise MalformedUpstream("AI Core response is not a JSON object")
    return response


def parse_probas(
    response: Any, n_rows: int
) -> tuple[tuple[str, ...], tuple[tuple[float, ...], ...]]:
    body = _object(response)
    classes = body.get("class_labels")
    if classes is None and isinstance(body.get("metadata"), dict):
        classes = body["metadata"].get("classes")
    if not isinstance(classes, list) or not classes:
        raise MalformedUpstream("AI Core response has no class_labels")
    labels = tuple(str(c) for c in classes)
    prediction = body.get("prediction")
    if not isinstance(prediction, list) or len(prediction) != n_rows:
        raise MalformedUpstream("AI Core prediction length does not match x_test rows")
    scores = []
    for row in prediction:
        if not isinstance(row, list) or len(row) != len(labels):
            raise MalformedUpstream("AI Core score vector length does not match classes")
        scores.append(tuple(_finite(v) for v in row))
    return labels, tuple(scores)


def parse_points(response: Any, n_rows: int) -> tuple[float, ...]:
    prediction = _object(response).get("prediction")
    if isinstance(prediction, dict):
        prediction = prediction.get("mean")
    if not isinstance(prediction, list) or len(prediction) != n_rows:
        raise MalformedUpstream("AI Core prediction length does not match x_test rows")
    return tuple(_finite(v) for v in prediction)


def parse_quantiles(response: Any, n_levels: int, n_rows: int) -> tuple[tuple[float, ...], ...]:
    """Rows x levels, validated without repair. The deployment answers levels x rows.

    With as many rows as levels the layout is ambiguous; the documented
    levels-first layout is assumed then.
    """
    prediction = _object(response).get("prediction")
    if isinstance(prediction, dict):
        prediction = prediction.get("quantiles")
    if not isinstance(prediction, list) or not all(isinstance(r, list) for r in prediction):
        raise MalformedUpstream("AI Core quantile prediction is not a 2-d list")
    grid = [[_finite(v) for v in row] for row in prediction]
    if len(grid) == n_levels and all(len(r) == n_rows for r in grid):
        grid = [list(col) for col in zip(*grid, strict=True)] if n_rows else []
    elif not (len(grid) == n_rows and all(len(r) == n_levels for r in grid)):
        raise MalformedUpstream("AI Core quantile shape does not match levels x rows")
    return tuple(checked_quantile_row(tuple(row)) for row in grid)


def _usage(response: Any) -> BackendUsage:
    usage = response.get("usage") if isinstance(response, dict) else None
    metadata = response.get("metadata", {}) if isinstance(response, dict) else {}
    version = response.get("model_version") if isinstance(response, dict) else None
    if version is None and isinstance(metadata, dict):
        version = metadata.get("model_version")
    version = (
        version.strip() if isinstance(version, str) and 0 < len(version.strip()) <= 80 else None
    )
    if not isinstance(usage, dict):
        return BackendUsage(model_version=version)

    def count(key: str) -> int | None:
        value = usage.get(key)
        if value is None:
            return None
        if (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or not math.isfinite(value)
            or value < 0
            or value != int(value)
        ):
            raise MalformedUpstream("AI Core response contains invalid usage counts")
        return int(value)

    return BackendUsage(
        num_cells=count("num_cells"),
        num_predictions=count("num_predictions"),
        model_version=version,
    )
