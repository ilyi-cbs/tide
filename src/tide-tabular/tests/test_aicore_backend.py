from __future__ import annotations

import json

import httpx
import pytest
import respx

from tabular.domain.errors import (
    ConfigurationError,
    OutcomeUnknown,
    UpstreamError,
    UpstreamRejected,
    UpstreamTimeout,
)
from tabular.domain.models import ClassProbas, ColumnSpec, OutputSpec, Points, QuantileGrid
from tabular.infrastructure.backends import aicore
from tabular.infrastructure.backends.aicore import AiCoreBackend
from tabular.settings import AiCoreConfig, Settings

AUTH = "https://auth.example.com/oauth/token"
DEPLOY = "https://api.example.com/v2/inference/deployments/deploy-1"
COLS = (ColumnSpec("Plant", "categorical"), ColumnSpec("Qty", "numeric"))


def make_settings(**overrides) -> AiCoreConfig:
    defaults = dict(
        aicore_auth_url="https://auth.example.com",
        aicore_api_url="https://api.example.com",
        aicore_client_id="id",
        aicore_client_secret="secret",
        aicore_deployment_id="deploy-1",
    )
    defaults.update(overrides)
    return Settings(_env_file=None, **defaults).aicore_config()


@pytest.fixture
def slept():
    return []


@pytest.fixture
def backend(slept) -> AiCoreBackend:
    return AiCoreBackend(make_settings(), sleep=slept.append)


def token_route(token="t1", expires_in=3600):
    return respx.post(AUTH).mock(
        return_value=httpx.Response(200, json={"access_token": token, "expires_in": expires_in})
    )


POINT = OutputSpec("point")


def call(backend, output=POINT, task="regression", n_test=2, timeout_s=30):
    y = ["yes", "no"] if task == "classification" else [1.0, 2.0]
    return backend.fit_predict(
        task=task,
        columns=COLS,
        x_train=[["P1", 1], ["P2", 2]],
        y_train=y,
        x_test=[["P1", 3], ["P2", 4]][:n_test],
        output=output,
        timeout_s=timeout_s,
    )


def test_missing_config_raises_configuration_error():
    with pytest.raises(ConfigurationError, match="AICORE_AUTH_URL"):
        Settings(_env_file=None).aicore_config()


@respx.mock
def test_golden_payload_and_headers(backend):
    token_route()
    route = respx.post(f"{DEPLOY}/predict").mock(
        return_value=httpx.Response(200, json={"prediction": [[1.0, 2.0], [3.0, 4.0]]})
    )
    call(backend, OutputSpec("quantiles", (0.1, 0.9)))
    sent = route.calls[0].request
    assert sent.headers["Authorization"] == "Bearer t1"
    assert sent.headers["AI-Resource-Group"] == "default"
    assert json.loads(sent.content) == {
        "x_train": {"Plant": ["P1", "P2"], "Qty": [1, 2]},
        "y_train": {"target": [1.0, 2.0]},
        "x_test": {"Plant": ["P1", "P2"], "Qty": [3, 4]},
        "task_config": {
            "task": "regression",
            "predict_params": {"output_type": "quantiles", "quantiles": [0.1, 0.9]},
            "tabpfn_config": {"categorical_features_indices": [0]},
        },
    }


@respx.mock
def test_deployment_url_setting_wins():
    token_route()
    route = respx.post("https://custom.example.com/d/predict").mock(
        return_value=httpx.Response(200, json={"prediction": [1.0, 2.0]})
    )
    backend = AiCoreBackend(make_settings(aicore_deployment_url="https://custom.example.com/d/"))
    assert call(backend).points == (1.0, 2.0)
    assert route.called


@respx.mock
@pytest.mark.parametrize(
    "body",
    [
        {"class_labels": ["no", "yes"], "prediction": [[0.1, 0.9], [0.7, 0.3]]},
        {"metadata": {"classes": ["no", "yes"]}, "prediction": [[0.1, 0.9], [0.7, 0.3]]},
    ],
)
def test_classification_reads_class_labels_or_metadata(backend, body):
    token_route()
    route = respx.post(f"{DEPLOY}/predict").mock(return_value=httpx.Response(200, json=body))
    output = call(backend, OutputSpec("probas"), task="classification")
    assert isinstance(output, ClassProbas)
    assert output.classes == ("no", "yes")
    assert output.scores == ((0.1, 0.9), (0.7, 0.3))
    params = json.loads(route.calls[0].request.content)["task_config"]["predict_params"]
    assert params == {"output_type": "probas"}


@respx.mock
def test_point_maps_to_mean_and_reads_usage(backend):
    token_route()
    route = respx.post(f"{DEPLOY}/predict").mock(
        return_value=httpx.Response(
            200,
            json={"prediction": [1.5, 2.5], "usage": {"num_cells": 12, "num_predictions": 2}},
        )
    )
    output = call(backend)
    assert isinstance(output, Points)
    assert output.points == (1.5, 2.5)
    assert output.usage.num_cells == 12 and output.usage.num_predictions == 2
    params = json.loads(route.calls[0].request.content)["task_config"]["predict_params"]
    assert params == {"output_type": "mean"}


@pytest.mark.parametrize(
    ("prediction", "expected"),
    [
        # levels x rows (documented layout): transposed
        ([[1.0, 2.0, 3.0], [7.0, 8.0, 9.0]], ((1.0, 7.0), (2.0, 8.0), (3.0, 9.0))),
        # wrapped
        ({"quantiles": [[1.0, 2.0, 3.0], [7.0, 8.0, 9.0]]}, ((1.0, 7.0), (2.0, 8.0), (3.0, 9.0))),
        # already rows x levels
        ([[1.0, 7.0], [2.0, 8.0], [3.0, 9.0]], ((1.0, 7.0), (2.0, 8.0), (3.0, 9.0))),
    ],
)
def test_quantile_parser(prediction, expected):
    assert aicore.parse_quantiles({"prediction": prediction}, 2, 3) == expected


def test_square_quantile_grid_is_read_levels_first():
    grid = aicore.parse_quantiles({"prediction": [[1.0, 2.0], [5.0, 6.0]]}, 2, 2)
    assert grid == ((1.0, 5.0), (2.0, 6.0))


@pytest.mark.parametrize(
    "prediction",
    [[[1.0, 2.0]], [[1.0, float("nan"), 3.0], [1.0, 2.0, 3.0]], "x", [[True, 1.0, 2.0]] * 2],
)
def test_bad_quantile_shapes_are_upstream_errors(prediction):
    with pytest.raises(UpstreamError):
        aicore.parse_quantiles({"prediction": prediction}, 2, 3)


@respx.mock
def test_quantile_call_returns_a_grid(backend):
    token_route()
    respx.post(f"{DEPLOY}/predict").mock(
        return_value=httpx.Response(200, json={"prediction": [[1.0, 2.0], [5.0, 6.0]]})
    )
    output = call(backend, OutputSpec("quantiles", (0.1, 0.9)))
    assert isinstance(output, QuantileGrid)
    assert output.values == ((1.0, 5.0), (2.0, 6.0))


@respx.mock
def test_token_is_cached_and_invalidated_without_replay_on_401(backend):
    tokens = respx.post(AUTH).mock(
        side_effect=[
            httpx.Response(200, json={"access_token": "t1", "expires_in": 3600}),
            httpx.Response(200, json={"access_token": "t2", "expires_in": 3600}),
        ]
    )
    route = respx.post(f"{DEPLOY}/predict").mock(
        side_effect=[
            httpx.Response(200, json={"prediction": [1.0, 2.0]}),
            httpx.Response(401),
            httpx.Response(200, json={"prediction": [1.0, 2.0]}),
        ]
    )
    call(backend)
    with pytest.raises(UpstreamRejected):
        call(backend)
    call(backend)
    assert tokens.call_count == 2
    assert [c.request.headers["Authorization"] for c in route.calls] == [
        "Bearer t1",
        "Bearer t1",
        "Bearer t2",
    ]


@respx.mock
def test_rejected_credentials_are_a_configuration_error(backend):
    respx.post(AUTH).mock(return_value=httpx.Response(401, text="bad client secret"))
    with pytest.raises(ConfigurationError) as info:
        call(backend)
    assert "secret" not in str(info.value)


@respx.mock
def test_429_is_not_replayed_without_nonexecution_guarantee(backend, slept):
    token_route()
    route = respx.post(f"{DEPLOY}/predict").mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "2"}),
            httpx.Response(200, json={"prediction": [1.0, 2.0]}),
        ]
    )
    with pytest.raises(OutcomeUnknown):
        call(backend)
    assert route.call_count == 1
    assert 2.0 not in slept


@respx.mock
def test_5xx_is_not_replayed(backend):
    token_route()
    route = respx.post(f"{DEPLOY}/predict").mock(
        return_value=httpx.Response(503, text="upstream internal detail")
    )
    with pytest.raises(OutcomeUnknown) as info:
        call(backend)
    assert not info.value.retryable
    assert route.call_count == 1
    assert "internal detail" not in str(info.value)


@respx.mock
def test_no_retry_past_the_deadline(backend):
    token_route()
    route = respx.post(f"{DEPLOY}/predict").mock(
        return_value=httpx.Response(429, headers={"Retry-After": "60"})
    )
    with pytest.raises(OutcomeUnknown):
        call(backend, timeout_s=5)
    assert route.call_count == 1


@respx.mock
def test_4xx_is_rejected_and_not_retried(backend):
    token_route()
    route = respx.post(f"{DEPLOY}/predict").mock(
        return_value=httpx.Response(413, text="payload with customer rows")
    )
    with pytest.raises(UpstreamRejected) as info:
        call(backend)
    assert not info.value.retryable
    assert route.call_count == 1
    assert "customer" not in str(info.value)


@respx.mock
def test_timeout_raises_upstream_timeout(backend):
    token_route()
    respx.post(f"{DEPLOY}/predict").mock(side_effect=httpx.ReadTimeout("boom"))
    with pytest.raises(UpstreamTimeout):
        call(backend)


@respx.mock
def test_malformed_response_raises_upstream_error(backend):
    token_route()
    respx.post(f"{DEPLOY}/predict").mock(
        return_value=httpx.Response(
            200, content=b'{"prediction": [NaN, 1]}', headers={"content-type": "application/json"}
        )
    )
    with pytest.raises(UpstreamError):
        call(backend)


def test_exhausted_deadline_fails_without_calling(backend):
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(f"{DEPLOY}/predict")
        with pytest.raises(UpstreamTimeout):
            call(backend, timeout_s=0)
        assert not route.called
