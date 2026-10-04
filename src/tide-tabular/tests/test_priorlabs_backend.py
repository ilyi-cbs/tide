from __future__ import annotations

import time

import httpx
import numpy as np
import pytest
from tabpfn_client.errors import (
    CappedRetryableServerError,
    FittedModelNotFoundError,
    RetryableServerError,
)

from tabular.domain.errors import (
    ConfigurationError,
    MalformedUpstream,
    ModelReferenceInvalid,
    OutcomeUnknown,
    UnsupportedCapability,
    UpstreamError,
    UpstreamRejected,
    UpstreamTimeout,
)
from tabular.domain.models import ClassProbas, ColumnSpec, OutputSpec, Points, QuantileGrid
from tabular.infrastructure.backends.priorlabs import PriorLabsBackend
from tabular.settings import PriorLabsConfig, Settings

COLS = (ColumnSpec("a", "numeric"),)


def test_selected_model_capabilities_are_configurable(monkeypatch):
    backend = make_backend(monkeypatch, priorlabs_max_classes=200, priorlabs_max_test_batch=2000)
    assert backend.capabilities.max_classes == 200
    assert backend.capabilities.max_test_batch == 2000


class SelectedModel:
    def __init__(self, *, model_path, categorical_features_indices, client_options):
        assert model_path == "v3.5_default"
        assert categorical_features_indices == []
        assert client_options.timeout > 0
        self.model_path = model_path


def make_settings(**overrides) -> PriorLabsConfig:
    defaults = dict(priorlabs_api_key="test-key")
    defaults.update(overrides)
    return Settings(_env_file=None, **defaults).priorlabs_config()


def make_backend(monkeypatch, **overrides) -> PriorLabsBackend:
    monkeypatch.setattr(
        "tabular.infrastructure.backends.priorlabs.set_access_token", lambda t: None
    )
    return PriorLabsBackend(make_settings(**overrides))


def test_missing_api_key_raises_configuration_error():
    with pytest.raises(ConfigurationError):
        Settings(_env_file=None).priorlabs_config()


def test_classification_happy_path(monkeypatch):
    backend = make_backend(monkeypatch)

    class FakeClassifier(SelectedModel):
        def fit(self, x, y):
            self.classes_ = np.array(["no", "yes"])
            return self

        def predict_proba(self, x):
            return np.array([[0.1, 0.9], [0.7, 0.3]])

    monkeypatch.setattr(
        "tabular.infrastructure.backends.priorlabs.TabPFNClassifier", FakeClassifier
    )
    output = backend.fit_predict(
        task="classification",
        columns=COLS,
        output=OutputSpec("probas"),
        x_train=[[1], [2]],
        y_train=["yes", "no"],
        x_test=[[3], [4]],
        timeout_s=30,
    )
    assert isinstance(output, ClassProbas)
    assert output.classes == ("no", "yes")
    assert output.scores == ((0.1, 0.9), (0.7, 0.3))


def test_regression_happy_path(monkeypatch):
    backend = make_backend(monkeypatch)

    class FakeRegressor(SelectedModel):
        def fit(self, x, y):
            return self

        def predict(self, x, output_type="mean", quantiles=None):
            assert output_type == "mean"
            return np.array([1.5, 2.5])

    monkeypatch.setattr("tabular.infrastructure.backends.priorlabs.TabPFNRegressor", FakeRegressor)
    output = backend.fit_predict(
        task="regression",
        columns=COLS,
        output=OutputSpec("point"),
        x_train=[[1], [2]],
        y_train=[1.0, 2.0],
        x_test=[[3], [4]],
        timeout_s=30,
    )
    assert isinstance(output, Points)
    assert output.points == (1.5, 2.5)


def test_malformed_prediction_raises_upstream_error(monkeypatch):
    backend = make_backend(monkeypatch)

    class FakeRegressor(SelectedModel):
        def fit(self, x, y):
            return self

        def predict(self, x, output_type="mean", quantiles=None):
            return np.array([float("nan")])

    monkeypatch.setattr("tabular.infrastructure.backends.priorlabs.TabPFNRegressor", FakeRegressor)
    with pytest.raises(UpstreamError):
        backend.fit_predict(
            task="regression",
            columns=COLS,
            output=OutputSpec("point"),
            x_train=[[1]],
            y_train=[1.0],
            x_test=[[2]],
            timeout_s=30,
        )


def test_timeout_raises_upstream_timeout(monkeypatch):
    backend = make_backend(monkeypatch)

    class FakeRegressor(SelectedModel):
        def fit(self, x, y):
            raise httpx.ConnectTimeout("boom")

    monkeypatch.setattr("tabular.infrastructure.backends.priorlabs.TabPFNRegressor", FakeRegressor)
    with pytest.raises(UpstreamTimeout):
        backend.fit_predict(
            task="regression",
            columns=COLS,
            output=OutputSpec("point"),
            x_train=[[1]],
            y_train=[1.0],
            x_test=[[2]],
            timeout_s=30,
        )


@pytest.mark.parametrize(
    "exc",
    [
        RetryableServerError("boom"),
        CappedRetryableServerError("boom"),
        FittedModelNotFoundError("boom"),
        RuntimeError("boom"),
    ],
)
def test_library_errors_have_unknown_nonretryable_outcomes(monkeypatch, exc):
    backend = make_backend(monkeypatch)

    class FakeRegressor(SelectedModel):
        def fit(self, x, y):
            raise exc

    monkeypatch.setattr("tabular.infrastructure.backends.priorlabs.TabPFNRegressor", FakeRegressor)
    with pytest.raises(OutcomeUnknown) as error:
        backend.fit_predict(
            task="regression",
            columns=COLS,
            output=OutputSpec("point"),
            x_train=[[1]],
            y_train=[1.0],
            x_test=[[2]],
            timeout_s=30,
        )
    assert error.value.retryable is False


def test_value_error_maps_to_upstream_rejected(monkeypatch):
    backend = make_backend(monkeypatch)

    class FakeRegressor(SelectedModel):
        def fit(self, x, y):
            raise ValueError("bad input")

    monkeypatch.setattr("tabular.infrastructure.backends.priorlabs.TabPFNRegressor", FakeRegressor)
    with pytest.raises(UpstreamRejected):
        backend.fit_predict(
            task="regression",
            columns=COLS,
            output=OutputSpec("point"),
            x_train=[[1]],
            y_train=[1.0],
            x_test=[[2]],
            timeout_s=30,
        )


def test_quantiles_use_the_library_quantile_output(monkeypatch):
    backend = make_backend(monkeypatch)
    seen = {}

    class FakeRegressor(SelectedModel):
        def fit(self, x, y):
            return self

        def predict(self, x, output_type="mean", quantiles=None):
            seen.update(output_type=output_type, quantiles=quantiles)
            return [np.array([1.0, 2.0]), np.array([9.0, 8.0])]  # levels x rows

    monkeypatch.setattr("tabular.infrastructure.backends.priorlabs.TabPFNRegressor", FakeRegressor)
    output = backend.fit_predict(
        task="regression",
        columns=COLS,
        output=OutputSpec("quantiles", (0.1, 0.9)),
        x_train=[[1], [2]],
        y_train=[1.0, 2.0],
        x_test=[[3], [4]],
        timeout_s=30,
    )
    assert isinstance(output, QuantileGrid)
    assert output.values == ((1.0, 9.0), (2.0, 8.0))
    assert seen == {"output_type": "quantiles", "quantiles": [0.1, 0.9]}


def test_expired_fit_never_starts_prediction(monkeypatch):
    backend = make_backend(monkeypatch)
    clock = [100.0]
    monkeypatch.setattr(
        "tabular.infrastructure.backends.priorlabs.time.monotonic", lambda: clock[0]
    )

    class SlowRegressor(SelectedModel):
        def fit(self, x, y):
            clock[0] += 1
            return self

        def predict(self, *args, **kwargs):
            pytest.fail("prediction must not start after the fit deadline")

    monkeypatch.setattr("tabular.infrastructure.backends.priorlabs.TabPFNRegressor", SlowRegressor)
    with pytest.raises(OutcomeUnknown):
        backend.fit_predict(
            task="regression",
            columns=COLS,
            output=OutputSpec("point"),
            x_train=[[1]],
            y_train=[1.0],
            x_test=[[2]],
            timeout_s=0.05,
        )


def test_conversion_time_consumes_budget_before_fit(monkeypatch):
    backend = make_backend(monkeypatch)
    clock = [100.0]
    original = np.asarray

    def conversion(*args, **kwargs):
        clock[0] += 1
        return original(*args, **kwargs)

    class NeverFit(SelectedModel):
        def fit(self, *args):
            pytest.fail("fit must not start after conversion consumed the deadline")

    monkeypatch.setattr(
        "tabular.infrastructure.backends.priorlabs.time.monotonic", lambda: clock[0]
    )
    monkeypatch.setattr("tabular.infrastructure.backends.priorlabs.np.asarray", conversion)
    monkeypatch.setattr("tabular.infrastructure.backends.priorlabs.TabPFNRegressor", NeverFit)
    with pytest.raises(UpstreamTimeout) as error:
        backend.fit_predict(
            task="regression",
            columns=COLS,
            output=OutputSpec("point"),
            x_train=[[1], [2]],
            y_train=[1.0, 2.0],
            x_test=[[3]],
            timeout_s=1,
        )
    assert error.value.retryable


@pytest.mark.parametrize("prediction", [None, 2.0, [[2.0]], [True]])
def test_malformed_point_shapes_are_not_internal_errors(monkeypatch, prediction):
    backend = make_backend(monkeypatch)

    class InvalidRegressor(SelectedModel):
        def fit(self, x, y):
            return self

        def predict(self, *args, **kwargs):
            return prediction

    monkeypatch.setattr(
        "tabular.infrastructure.backends.priorlabs.TabPFNRegressor", InvalidRegressor
    )
    with pytest.raises(MalformedUpstream) as error:
        backend.fit_predict(
            task="regression",
            columns=COLS,
            output=OutputSpec("point"),
            x_train=[[1], [2]],
            y_train=[1.0, 2.0],
            x_test=[[3]],
            timeout_s=30,
        )
    assert not error.value.retryable


def test_categorical_indices_follow_effective_columns(monkeypatch):
    backend = make_backend(monkeypatch)

    class CategoricalRegressor:
        model_path = "v3.5_default"

        def __init__(self, *, model_path, categorical_features_indices, client_options):
            assert categorical_features_indices == [1]
            assert client_options.timeout > 0

        def fit(self, x, y):
            return self

        def predict(self, x, output_type):
            return [2.0]

    monkeypatch.setattr(
        "tabular.infrastructure.backends.priorlabs.TabPFNRegressor", CategoricalRegressor
    )
    result = backend.fit_predict(
        task="regression",
        columns=(COLS[0], ColumnSpec("category", "categorical")),
        output=OutputSpec("point"),
        x_train=[[1, "a"], [2, "b"]],
        y_train=[1.0, 2.0],
        x_test=[[3, "a"]],
        timeout_s=30,
    )
    assert result.points == (2.0,)


@pytest.mark.parametrize(
    "classes, probabilities",
    [
        (None, [[0.5, 0.5]]),
        ("yes", [[1.0]]),
        ([], [[]]),
        (["no", "yes"], None),
        (["no", "yes"], [0.5, 0.5]),
        (["no", "yes"], [[0.5]]),
        (["no", "yes"], [[0.5, 0.5], [1.0]]),
    ],
)
def test_malformed_classification_arrays(monkeypatch, classes, probabilities):
    backend = make_backend(monkeypatch)

    class InvalidClassifier(SelectedModel):
        def fit(self, x, y):
            self.classes_ = classes
            return self

        def predict_proba(self, x):
            return probabilities

    monkeypatch.setattr(
        "tabular.infrastructure.backends.priorlabs.TabPFNClassifier", InvalidClassifier
    )
    with pytest.raises(MalformedUpstream):
        backend.fit_predict(
            task="classification",
            columns=COLS,
            output=OutputSpec("probas"),
            x_train=[[1], [2]],
            y_train=["no", "yes"],
            x_test=[[3]],
            timeout_s=30,
        )


def test_configured_model_is_used_for_fit_and_provenance(monkeypatch):
    backend = make_backend(monkeypatch, priorlabs_model_path="custom-checkpoint")

    class ConfiguredRegressor:
        def __init__(self, *, model_path, categorical_features_indices, client_options):
            assert model_path == "custom-checkpoint"
            self.model_path = model_path

        def fit(self, x, y):
            return self

        def predict(self, x, output_type):
            return [2.0]

    monkeypatch.setattr(
        "tabular.infrastructure.backends.priorlabs.TabPFNRegressor", ConfiguredRegressor
    )
    result = backend.fit_predict(
        task="regression",
        columns=COLS,
        output=OutputSpec("point"),
        x_train=[[1], [2]],
        y_train=[1.0, 2.0],
        x_test=[[3]],
        timeout_s=30,
    )
    assert result.usage.model_version == "custom-checkpoint"


def test_messages_do_not_carry_library_text(monkeypatch):
    backend = make_backend(monkeypatch)

    class FakeRegressor(SelectedModel):
        def fit(self, x, y):
            raise ValueError("column 'secret' has customer values")

    monkeypatch.setattr("tabular.infrastructure.backends.priorlabs.TabPFNRegressor", FakeRegressor)
    with pytest.raises(UpstreamRejected) as info:
        backend.fit_predict(
            task="regression",
            columns=COLS,
            output=OutputSpec("point"),
            x_train=[[1]],
            y_train=[1.0],
            x_test=[[2]],
            timeout_s=30,
        )
    assert "secret" not in str(info.value)


@pytest.fixture
def native_sdk(monkeypatch):
    from tabular.infrastructure.backends import priorlabs

    models = []
    metadata_calls = []
    limits = {
        "train_set_max_rows": 100,
        "train_set_max_cells": 1000,
        "test_set_max_rows": 10,
        "max_classes": 10,
        "max_cols": 10,
        "test_set_max_rows_w_full_regression_output": 1,
        "predict_row_pairs_budget": 1000,
        "test_set_max_cells": 1000,
    }
    settings = {
        "default_model_version": "v3.5",
        "max_model_limit": limits,
        "model_limits": {"v3.5": limits},
        "dataset_max_size_bytes": 100000,
        "async_settings": {"use_above_trainset_size_bytes": 1000, "poll_timeout_secs": 30},
    }

    def metadata(path, *, timeout):
        assert path == "/tabpfn/get_settings"
        assert timeout > 0
        metadata_calls.append(timeout)
        return httpx.Response(
            200, json=settings, request=httpx.Request("GET", "https://offline/settings")
        )

    class NativeModel:
        def __init__(self, **options):
            self.options = options
            self.model_path = options["model_path"]
            self.client_options = options["client_options"]
            self.fit_calls = 0
            self.predictions = []
            self.record = None
            models.append(self)

        def fit(self, frame, targets):
            self.fit_calls += 1
            self.frame = frame
            self.targets = targets
            self.classes_ = np.array(sorted({str(value) for value in targets}))
            return self

        def predict_proba(self, frame):
            self.predictions.append(frame)
            return [[0.5, 0.5] for _ in range(len(frame))]

        def predict(self, frame, *, output_type, quantiles=None):
            self.predictions.append(frame)
            rows = len(frame)
            points = {"mean": 2.0, "median": 5.0, "mode": 4.0}
            if output_type in points:
                return [points[output_type]] * rows
            grid = [[level * 10] * rows for level in quantiles]
            if output_type == "quantiles":
                return grid
            return {
                "mean": [2.0] * rows,
                "median": [5.0] * rows,
                "mode": [4.0] * rows,
                "quantiles": grid,
                "borders": [0.0, 10.0, 20.0],
                "logits": [[0.0, float("-inf")] for _ in range(rows)],
            }

        def get_params(self, deep=False):
            return {key: value for key, value in self.options.items() if key != "client_options"}

        def get_timings(self):
            return {"fit": {"fit_s": 0.01, "nonfinite": float("nan"), "secret": "hidden"}}

        def save_model(self):
            if self.record is not None:
                return self.record
            return {
                "tabpfn_client_version": "0.6.0",
                "task": "regression",
                "model_id": "00000000-0000-0000-0000-000000000001",
                "params": self.get_params(),
                "n_train_rows": len(self.frame),
                "classes": None,
            }

        @classmethod
        def load_model(cls, record):
            from tabpfn_client.models import ClientOptions

            model = cls(**record["params"], client_options=ClientOptions())
            model.record = record
            model.classes_ = np.array(record.get("classes") or [])
            return model

    monkeypatch.setattr(priorlabs, "_CREDENTIAL_BINDING", None)
    monkeypatch.setattr(priorlabs, "set_access_token", lambda token: None)
    monkeypatch.setattr(priorlabs.ServiceClient.httpx_client, "get", metadata)
    monkeypatch.setattr(priorlabs, "TabPFNClassifier", NativeModel)
    monkeypatch.setattr(priorlabs, "TabPFNRegressor", NativeModel)
    return models, settings, metadata_calls


def _native_fit(backend, **overrides):
    arguments = dict(
        task="regression",
        columns=COLS,
        x_train=[[1], [2], [3]],
        y_train=[1.0, 2.0, 3.0],
        model_options={},
        fit_options={},
        timeout_s=30,
    )
    arguments.update(overrides)
    return backend.fit(**arguments)


@pytest.mark.parametrize(
    "option,value",
    [
        ("n_estimators", 4),
        ("random_state", 7),
        ("softmax_temperature", 0.8),
        ("balance_probabilities", True),
        ("average_before_softmax", True),
        ("inference_precision", "autocast"),
        ("inference_config", {"SUBSAMPLE_SAMPLES": 2}),
        ("ignore_pretraining_limits", True),
        ("paper_version", True),
    ],
)
def test_native_model_options_are_forwarded(native_sdk, monkeypatch, option, value):
    from tabular.api.schemas import ModelOptionsDTO

    validated = ModelOptionsDTO.model_validate({option: value}).model_dump(exclude_unset=True)
    backend = make_backend(monkeypatch)
    task = "classification" if option == "balance_probabilities" else "regression"
    fitted = _native_fit(backend, task=task, model_options=validated)
    assert native_sdk[0][0].options[option] == value
    assert fitted.describe()["effective_model_options"][option] == value
    assert fitted.describe()["timings"] == {"fit": {"fit_s": 0.01}}


@pytest.mark.parametrize(
    "option,value,sdk_name",
    [
        ("thinking_mode", True, "thinking_mode"),
        ("thinking_effort", "high", "thinking_effort"),
        ("fit_timeout", 10.0, "thinking_timeout_s"),
        ("thinking_metric", "rmse", "thinking_metric"),
        ("fit_mode", "fit_with_cache", "fit_mode"),
        ("group_columns", ["a"], "group_col"),
        ("time_column", "a", "time_col"),
        ("grouped_time_column", "a", "group_time_col"),
    ],
)
def test_native_fit_options_use_sdk_names(native_sdk, monkeypatch, option, value, sdk_name):
    from tabular.api.schemas import FitOptionsDTO

    validated = FitOptionsDTO.model_validate({option: value}).model_dump(exclude_none=True)
    _native_fit(make_backend(monkeypatch), fit_options=validated)
    assert native_sdk[0][0].options[sdk_name] == value


@pytest.mark.parametrize(
    "output_type,statistic",
    [
        ("point", "mean"),
        ("point", "median"),
        ("point", "mode"),
        ("quantiles", "mean"),
        ("summary", "mean"),
        ("distribution", "mean"),
    ],
)
def test_native_fit_once_for_all_outputs(native_sdk, monkeypatch, limits, output_type, statistic):
    from tabular.api.schemas import PredictRequestV3DTO, TabularResultV3DTO
    from tabular.application.predict import PredictService

    request = PredictRequestV3DTO.model_validate(
        {
            "task": "regression",
            "backendKey": "priorlabs",
            "modelKey": "default",
            "columns": [{"name": "a", "kind": "numeric"}],
            "x_train": [[1], [2], [3]],
            "y_train": [1, 2, 3],
            "keys": ["a", "b", "c"],
            "x_test": [[4], [5], [6]],
            "output": {
                "type": output_type,
                "statistic": statistic,
                **({"levels": [0.1, 0.5, 0.9]} if output_type != "point" else {}),
            },
        }
    ).to_domain()
    service = PredictService(make_backend(monkeypatch), limits, cache_identity="account")
    result = service.run_v3(request, deadline=time.monotonic() + 30)
    response = TabularResultV3DTO.of(
        request, result, "account", service.capability_digest, service.plan_fingerprint(request)
    ).model_dump()
    model = native_sdk[0][0]
    assert model.fit_calls == 1
    assert result.usage.context_cells == 6
    assert len(model.predictions) == (3 if output_type == "distribution" else 2)
    assert result.diagnostics["fit_strategy"] == "native_fit_once"
    assert response["payload"]["keys"] == ["a", "b", "c"]
    if output_type == "distribution":
        assert all(chunk["logits"] == [[0.0, None]] for chunk in response["payload"]["chunks"])
        assert all(
            chunk["masked_logits"] == [[False, True]] for chunk in response["payload"]["chunks"]
        )
    assert len(native_sdk[2]) == 1


def test_native_reference_roundtrip_without_refitting(native_sdk, monkeypatch, limits):
    from tabular.api.schemas import FitRequestV3DTO, PredictRequestV3DTO
    from tabular.application.predict import PredictService
    from tabular.application.references import ReferenceCodec

    service = PredictService(make_backend(monkeypatch), limits, cache_identity="account")
    body = {
        "task": "regression",
        "backendKey": "priorlabs",
        "modelKey": "default",
        "columns": [{"name": "a", "kind": "numeric"}],
        "x_train": [[1], [2], [3]],
        "y_train": [1, 2, 3],
    }
    manifest = service.fit_v3(
        FitRequestV3DTO.model_validate(body).to_domain(), deadline=time.monotonic() + 30
    )
    codec = ReferenceCodec("s" * 32, 60)
    token, _ = codec.encode(manifest)
    manifest = codec.decode(token, backend_key="priorlabs", model_key="default", identity="account")
    request = PredictRequestV3DTO.model_validate(
        {
            **{key: value for key, value in body.items() if key not in ("x_train", "y_train")},
            "keys": ["prediction"],
            "x_test": [[4]],
            "output": {"type": "point"},
        }
    ).to_domain()
    result = service.predict_reference_v3(request, manifest, deadline=time.monotonic() + 30)
    assert [model.fit_calls for model in native_sdk[0]] == [1, 0]
    assert result.diagnostics["fit_calls"] == 0
    assert result.usage.context_cells == 0
    assert result.predictions[0].value == 2.0
    assert "client_options" not in manifest["record"]["params"]
    assert len(native_sdk[2]) == 2


def test_named_mixed_inputs_retain_constant_metadata(native_sdk, monkeypatch, limits):
    from tabular.api.schemas import PredictRequestV3DTO
    from tabular.application.predict import PredictService

    request = PredictRequestV3DTO.model_validate(
        {
            "task": "regression",
            "backendKey": "priorlabs",
            "modelKey": "default",
            "columns": [
                {"name": "constant", "kind": "numeric"},
                {"name": "group", "kind": "categorical"},
                {"name": "time", "kind": "numeric"},
                {"name": "text", "kind": "text"},
            ],
            "x_train": [[7, "G", 1, "hello"], [7, "G", 2, None], [7, "G", 3, "world"]],
            "y_train": [1, 2, 3],
            "keys": ["a"],
            "x_test": [[7, "G", 4, "new text"]],
            "fitOptions": {
                "thinking_mode": True,
                "group_columns": ["group"],
                "grouped_time_column": "time",
            },
            "output": {"type": "point"},
        }
    ).to_domain()
    result = PredictService(make_backend(monkeypatch), limits).run_v3(
        request, deadline=time.monotonic() + 30
    )
    model = native_sdk[0][0]
    assert list(model.frame.columns) == ["group", "time", "text"]
    assert model.frame.values.tolist() == [["G", 1, "hello"], ["G", 2, None], ["G", 3, "world"]]
    assert model.predictions[0].values.tolist() == [["G", 4, "new text"]]
    assert model.options["categorical_features_indices"] == [0]
    assert result.dropped_columns == ("constant",)


@pytest.mark.parametrize(
    "fit_options",
    [
        {"group_columns": ["a"]},
        {"time_column": "a"},
        {"fit_timeout": 1.0},
        {"thinking_metric": "rmse"},
        {"thinking_mode": True, "group_columns": ["a"], "time_column": "a"},
        {"thinking_mode": True, "grouped_time_column": "a"},
        {"thinking_mode": True, "group_columns": ["missing"]},
        {"thinking_mode": True, "group_columns": ["a", "a"]},
        {"thinking_effort": "high", "fit_mode": "fit_with_cache"},
    ],
)
def test_invalid_fit_combinations_reject_before_metadata(
    native_sdk, monkeypatch, limits, fit_options
):
    from tabular.api.schemas import PredictRequestV3DTO
    from tabular.application.predict import PredictService
    from tabular.domain.errors import ValidationFailure

    request = PredictRequestV3DTO.model_validate(
        {
            "task": "regression",
            "backendKey": "priorlabs",
            "modelKey": "default",
            "columns": [{"name": "a", "kind": "numeric"}],
            "x_train": [[1], [2]],
            "y_train": [1, 2],
            "keys": ["a"],
            "x_test": [[3]],
            "output": {"type": "point"},
            "fitOptions": fit_options,
        }
    ).to_domain()
    with pytest.raises(ValidationFailure):
        PredictService(make_backend(monkeypatch), limits).run_v3(
            request, deadline=time.monotonic() + 30
        )
    assert not native_sdk[0]
    assert not native_sdk[2]


@pytest.mark.parametrize(
    "field,value",
    [
        ("train_set_max_rows", 2),
        ("train_set_max_cells", 2),
        ("max_cols", 0),
        ("max_classes", 1),
    ],
)
def test_provider_training_limits_reject_before_fit(native_sdk, monkeypatch, field, value):
    native_sdk[1]["model_limits"]["v3.5"][field] = value
    with pytest.raises(UpstreamRejected):
        _native_fit(make_backend(monkeypatch), task="classification", y_train=["a", "b", "a"])
    assert not native_sdk[0]


def test_provider_limits_refresh_and_freeze_per_session(native_sdk, monkeypatch):
    backend = make_backend(monkeypatch)
    first = _native_fit(backend)
    assert first.batch_limit(OutputSpec("point")) == 10
    native_sdk[1]["model_limits"]["v3.5"]["test_set_max_rows"] = 2
    second = _native_fit(backend)
    assert first.batch_limit(OutputSpec("point")) == 10
    assert second.batch_limit(OutputSpec("point")) == 2
    assert second.batch_limit(OutputSpec("distribution")) == 1
    assert len(native_sdk[2]) == 2


@pytest.mark.parametrize(
    "field,value,expected",
    [
        ("test_set_max_rows", 2, 2),
        ("test_set_max_cells", 2, 2),
        ("predict_row_pairs_budget", 6, 2),
    ],
)
def test_output_batch_limits_cover_all_provider_budgets(
    native_sdk, monkeypatch, field, value, expected
):
    native_sdk[1]["model_limits"]["v3.5"][field] = value
    assert _native_fit(make_backend(monkeypatch)).batch_limit(OutputSpec("point")) == expected


def test_unknown_model_and_incompatible_cache_are_not_guessed(native_sdk, monkeypatch):
    with pytest.raises(UnsupportedCapability):
        _native_fit(make_backend(monkeypatch, priorlabs_model_path="unverified-model"))
    native_sdk[1]["model_limits"] = {"v2": native_sdk[1]["max_model_limit"]}
    with pytest.raises(UnsupportedCapability):
        _native_fit(
            make_backend(monkeypatch, priorlabs_model_path="v2_default"),
            fit_options={"fit_mode": "fit_with_cache"},
        )
    assert not native_sdk[0]


@pytest.mark.parametrize("payload", [None, {}, {"model_limits": {}}])
def test_invalid_service_metadata_never_fits(native_sdk, monkeypatch, payload):
    from tabular.infrastructure.backends.priorlabs import ServiceClient

    monkeypatch.setattr(
        ServiceClient.httpx_client,
        "get",
        lambda *args, **kwargs: httpx.Response(
            200, json=payload, request=httpx.Request("GET", "https://offline/settings")
        ),
    )
    with pytest.raises(MalformedUpstream):
        _native_fit(make_backend(monkeypatch))
    assert not native_sdk[0]


def test_no_provider_work_after_metadata_consumes_deadline(native_sdk, monkeypatch):
    from tabular.infrastructure.backends.priorlabs import ServiceClient

    clock = [100.0]
    original = ServiceClient.httpx_client.get

    def slow_settings(*args, **kwargs):
        clock[0] += 2
        return original(*args, **kwargs)

    monkeypatch.setattr(
        "tabular.infrastructure.backends.priorlabs.time.monotonic", lambda: clock[0]
    )
    monkeypatch.setattr(ServiceClient.httpx_client, "get", slow_settings)
    with pytest.raises(UpstreamTimeout) as error:
        _native_fit(make_backend(monkeypatch), timeout_s=1)
    assert error.value.retryable
    assert all(model.fit_calls == 0 for model in native_sdk[0])


def test_credentials_cannot_change_process_binding(native_sdk, monkeypatch):
    make_backend(monkeypatch)
    with pytest.raises(ConfigurationError):
        make_backend(monkeypatch, priorlabs_api_key="another-account")


@pytest.mark.parametrize(
    "mutation",
    [
        {"logits": [[None, 0.0]]},
        {"logits": [[float("nan"), 0.0]]},
        {"logits": [[float("inf"), 0.0]]},
        {"logits": [[float("-inf"), float("-inf")]]},
        {"logits": [[0.0]]},
        {"borders": [0.0, 0.0, 20.0]},
        {"borders": [20.0, 10.0, 0.0]},
        {"mean": [True]},
        {"quantiles": [[9.0], [1.0]]},
    ],
)
def test_native_malformed_distributions_are_nonretryable(native_sdk, monkeypatch, mutation):
    from tabular.application.predict import _to_predictions
    from tabular.infrastructure.backends.priorlabs import _parse_regression

    raw = {
        "mean": [2.0],
        "median": [5.0],
        "mode": [4.0],
        "quantiles": [[1.0], [9.0]],
        "borders": [0.0, 10.0, 20.0],
        "logits": [[0.0, float("-inf")]],
        **mutation,
    }
    output = OutputSpec("distribution", (0.1, 0.9))
    with pytest.raises(MalformedUpstream) as error:
        _to_predictions(("key",), _parse_regression(raw, 1, output, "v3.5_default"), output)
    assert not error.value.retryable


def test_expired_provider_fit_does_not_refit(native_sdk, monkeypatch):
    fitted = _native_fit(make_backend(monkeypatch))
    model = native_sdk[0][0]

    def missing(*args, **kwargs):
        raise FittedModelNotFoundError("private provider message")

    monkeypatch.setattr(model, "predict", missing)
    with pytest.raises(ModelReferenceInvalid) as error:
        fitted.predict([[4]], output=OutputSpec("point"), timeout_s=30)
    assert model.fit_calls == 1
    assert "private" not in str(error.value)
