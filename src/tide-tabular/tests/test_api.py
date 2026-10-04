import pytest
from fastapi.testclient import TestClient

from tabular.api.deps import get_predict_service
from tabular.api.main import app
from tabular.application.predict import PredictService
from tabular.domain.errors import UpstreamRejected
from tabular.domain.models import Capabilities
from tabular.infrastructure.backends.fake import FakeBackend
from tabular.settings import get_settings


@pytest.fixture
def client(limits):
    service = PredictService(backend=FakeBackend(), limits=limits)
    app.dependency_overrides[get_predict_service] = lambda: service
    try:
        # no `with`: skip lifespan, which would build the real configured service
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        app.dependency_overrides.clear()
        service.close()


def test_lifespan_drains_and_clears_closed_service(monkeypatch):
    monkeypatch.setenv("TABULAR_BACKEND", "fake")
    get_settings.cache_clear()
    get_predict_service.cache_clear()
    try:
        with TestClient(app) as running:
            service = get_predict_service()
            assert running.get("/health").json()["backend"] == "fake"
            assert len(running.get("/health").json()["identity"]) == 64
        assert get_predict_service.cache_info().currsize == 0
        assert service._closed
    finally:
        get_predict_service.cache_clear()
        get_settings.cache_clear()


def test_health_reports_the_backend(client):
    assert client.get("/health").json() == {"status": "ok", "backend": "fake"}


@pytest.mark.parametrize("backend_name", ["fake", "priorlabs", "aicore"])
def test_capability_discovery_is_explicit_and_never_dispatches(limits, backend_name):
    class MetadataBackend(FakeBackend):
        name = backend_name
        capabilities = Capabilities(max_test_batch=37, max_classes=17)

        def fit_predict(self, **kwargs):
            pytest.fail("capability discovery must not dispatch inference")

    service = PredictService(MetadataBackend(), limits, cache_identity="configured-runtime")
    app.dependency_overrides[get_predict_service] = lambda: service
    try:
        response = TestClient(app).get(
            "/v3/capabilities", headers={"X-Correlation-Id": "capability-check"}
        )
        assert response.status_code == 200, response.text
        assert response.headers["x-correlation-id"] == "capability-check"
        catalogue = response.json()
        assert catalogue["catalogue_version"] == 2
        assert catalogue["backend"] == backend_name
        assert catalogue["identity"] == "configured-runtime"
        assert catalogue["prediction_contract_versions"] == [2, 3]
        assert catalogue["verification"] == (
            "synthetic" if backend_name == "fake" else "offline-adapter-tests"
        )
        assert catalogue["live_verified"] is False
        assert catalogue["configured_limits"] == {"max_test_batch": 37, "max_classes": 17}
        assert catalogue["local_limits"]["max_context_rows"] == limits.max_context_rows
        assert catalogue["local_limits"]["max_concurrent_calls"] == limits.max_concurrent_calls
        assert catalogue["outputs"] == {
            "classification": ["labels", "probas"],
            "regression": ["mean", "median", "mode", "quantiles", "summary", "distribution"],
        }
        assert (
            next(
                feature for feature in catalogue["extensions"] if feature["name"] == "remote_cancel"
            )["status"]
            == "unsupported"
        )
        assert {feature["name"] for feature in catalogue["extensions"]} >= {
            "model_options",
            "thinking",
            "group_time",
            "fit_reuse",
            "remote_cancel",
        }
        assert "secret" not in response.text
        assert "deployment_url" not in response.text
        assert "api_key" not in response.text
    finally:
        app.dependency_overrides.clear()
        service.close()


def test_post_rejects_a_changed_configuration_before_inference(client, limits, body):
    service = PredictService(FakeBackend(), limits, cache_identity="current-model")
    app.dependency_overrides[get_predict_service] = lambda: service
    try:
        rejected = client.post(
            "/v1/tabular", json=body, headers={"X-Backend-Identity": "stale-model"}
        )
        assert rejected.status_code == 400
        assert rejected.json()["error"]["code"] == "VALIDATION"
        assert (
            client.post(
                "/v1/tabular", json=body, headers={"X-Backend-Identity": "current-model"}
            ).status_code
            == 200
        )
    finally:
        service.close()


def test_predict(client, body):
    response = client.post("/v1/tabular", json=body, headers={"X-Correlation-Id": "cid-1"})
    assert response.status_code == 200
    assert response.headers["x-correlation-id"] == "cid-1"
    result = response.json()
    assert result["train_rows"] == 3
    assert result["output_type"] == "probas"
    assert result["classes"] == ["no", "yes"]
    assert [p["row_key"] for p in result["predictions"]] == ["r4", "r5", "r6"]
    assert result["predictions"][0]["probabilities"] == pytest.approx([0.1, 0.9])
    assert result["placeholder"] is False
    assert result["usage"]["backend"] == "fake"
    assert result["dropped_columns"] == []


@pytest.mark.parametrize("output_type", ["labels", "probas"])
def test_v3_classification_has_a_typed_key_aligned_payload(client, body, output_type):
    body.update(backendKey="fake", modelKey="default", output={"type": output_type})
    response = client.post("/v3/tabular", json=body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["contract_version"] == 3
    assert result["backendKey"] == "fake"
    assert result["modelKey"] == "default"
    assert result["payload"]["type"] == output_type
    assert result["payload"]["keys"] == body["keys"]
    assert result["payload"]["classes"] == ["no", "yes"]
    if output_type == "labels":
        assert result["payload"]["values"] == ["yes"] * 3
    else:
        assert result["payload"]["values"][0] == pytest.approx([0.1, 0.9])


def test_v3_rejects_unknown_model_options_without_dispatch(client, body):
    body.update(backendKey="fake", modelKey="default", modelOptions={"secret": "never"})
    response = client.post("/v3/tabular", json=body)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VALIDATION"
    assert "never" not in response.text


def test_v3_never_falls_back_to_another_backend(client, body):
    body.update(backendKey="aicore", modelKey="default")
    response = client.post("/v3/tabular", json=body)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "UNSUPPORTED_CAPABILITY"


@pytest.mark.parametrize("statistic", ["mean", "median", "mode"])
def test_v3_point_preserves_the_requested_statistic(client, quantile_body, statistic):
    quantile_body.update(
        backendKey="fake", modelKey="default", output={"type": "point", "statistic": statistic}
    )
    response = client.post("/v3/tabular", json=quantile_body)
    assert response.status_code == 200, response.text
    payload = response.json()["payload"]
    assert payload["statistic"] == statistic
    assert payload["keys"] == quantile_body["keys"]
    expected = {"mean": 30.0, "median": 30.0, "mode": 10.0}[statistic]
    assert payload["values"] == [expected] * len(quantile_body["keys"])
    assert response.json()["placeholder"] is True


@pytest.mark.parametrize("output_type", ["summary", "distribution"])
def test_v3_rich_outputs_are_typed_and_chunk_aligned(client, quantile_body, output_type):
    quantile_body.update(
        backendKey="fake", modelKey="default", output={"type": output_type, "levels": [0.1, 0.9]}
    )
    response = client.post("/v3/tabular", json=quantile_body)
    assert response.status_code == 200, response.text
    payload = response.json()["payload"]
    assert payload["type"] == output_type
    assert payload["keys"] == quantile_body["keys"]
    summary = payload if output_type == "summary" else payload["summary"]
    assert summary["means"] == [30.0] * len(quantile_body["keys"])
    assert summary["medians"] == [30.0] * len(quantile_body["keys"])
    assert summary["modes"] == [10.0] * len(quantile_body["keys"])
    assert summary["levels"] == [0.1, 0.9]
    assert summary["quantiles"][0] == [14.0, 46.0]
    if output_type == "distribution":
        chunks = payload["chunks"]
        assert [key for chunk in chunks for key in chunk["keys"]] == quantile_body["keys"]
        for chunk in chunks:
            assert len(chunk["logits"]) == len(chunk["keys"])
            assert len(chunk["bucket_borders"]) == len(chunk["logits"][0]) + 1
            assert chunk["masked_logits"] == [[False] * len(chunk["logits"][0])] * len(
                chunk["keys"]
            )


def test_v3_has_configuration_and_capability_fingerprints(client, body):
    body.update(backendKey="fake", modelKey="default")
    first = client.post("/v3/tabular", json=body).json()
    assert len(first["capability_digest"]) == 64
    assert len(first["plan_fingerprint"]) == 64
    body["x_test"][0][0] = 17.0
    second = client.post("/v3/tabular", json=body).json()
    assert first["plan_fingerprint"] != second["plan_fingerprint"]
    assert first["capability_digest"] == second["capability_digest"]


def test_predict_quantiles(client, quantile_body):
    response = client.post("/v1/tabular", json=quantile_body)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["levels"] == [0.1, 0.9]
    first = result["predictions"][0]
    assert first["quantiles"] == [14.0, 46.0]
    assert first["value"] == 30.0
    assert result["classes"] is None


def test_dry_run_returns_placeholders(client, quantile_body):
    quantile_body["mode"] = "dry_run"
    result = client.post("/v1/tabular", json=quantile_body).json()
    assert result["placeholder"] is True
    assert result["usage"]["calls"] == 1
    assert result["usage"]["cost_units"] > 0


def test_old_contract_shape_is_rejected(client, body):
    body["columns"] = ["feature_a", "feature_b"]
    response = client.post("/v1/tabular", json=body)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VALIDATION"


def test_class_limit_is_400(limits, body):
    class Narrow(FakeBackend):
        capabilities = Capabilities(max_test_batch=10, max_classes=1)

    app.dependency_overrides[get_predict_service] = lambda: PredictService(Narrow(), limits)
    try:
        response = TestClient(app).post("/v1/tabular", json=body)
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "CLASS_LIMIT"


def test_limit_exceeded_is_413(client, body):
    body["x_train"] = [[float(i), "x"] for i in range(101)]
    body["y_train"] = ["yes", "no"] * 50 + ["yes"]
    response = client.post("/v1/tabular", json=body)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "LIMIT_EXCEEDED"


def test_oversized_body_is_413_before_parsing(client, body, monkeypatch):
    monkeypatch.setenv("TABULAR_MAX_BODY_BYTES", "50")
    get_settings.cache_clear()
    try:
        response = client.post("/v1/tabular", json=body, headers={"X-Correlation-Id": "big"})
    finally:
        get_settings.cache_clear()
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "LIMIT_EXCEEDED"
    assert response.headers["x-correlation-id"] == "big"


def test_unknown_route_has_the_error_shape(client):
    response = client.get("/nope")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NOT_FOUND"


def test_configured_token_is_required_for_inference(client, body, monkeypatch):
    monkeypatch.setenv("TABULAR_INTERNAL_TOKEN", "secret")
    get_settings.cache_clear()
    try:
        missing = client.post("/v1/tabular", json=body)
        wrong = client.post("/v1/tabular", json=body, headers={"Authorization": "Bearer x"})
        v3 = client.post("/v3/tabular", json={**body, "backendKey": "fake", "modelKey": "default"})
        accepted = client.post("/v1/tabular", json=body, headers={"Authorization": "Bearer secret"})
    finally:
        get_settings.cache_clear()
    assert missing.status_code == wrong.status_code == v3.status_code == 401
    assert missing.json()["error"]["code"] == "UNAUTHORIZED"
    assert accepted.status_code == 200


def test_non_loopback_bind_requires_a_token(monkeypatch):
    from tabular.api import main as entrypoint

    monkeypatch.setenv("TABULAR_HOST", "0.0.0.0")
    monkeypatch.delenv("TABULAR_INTERNAL_TOKEN", raising=False)
    monkeypatch.setattr("uvicorn.run", lambda *args, **kwargs: pytest.fail("must not serve"))
    get_settings.cache_clear()
    try:
        with pytest.raises(SystemExit, match="TABULAR_INTERNAL_TOKEN"):
            entrypoint.main()
    finally:
        get_settings.cache_clear()


def test_generates_a_correlation_id_when_missing(client, body):
    assert client.post("/v1/tabular", json=body).headers["x-correlation-id"]


def test_validation_error_has_the_error_shape(client, body):
    body["keys"] = ["r4"]
    response = client.post("/v1/tabular", json=body)
    assert response.status_code == 400
    assert response.json() == {
        "error": {
            "code": "VALIDATION",
            "message": "keys must have one value per x_test row",
            "retryable": False,
        }
    }


def test_schema_error_has_the_error_shape(client, body):
    body["feed"] = "some_table"
    response = client.post("/v1/tabular", json=body)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VALIDATION"


def test_expired_deadline_returns_504(client, body):
    response = client.post("/v1/tabular", json=body, headers={"X-Deadline-Ms": "100"})
    assert response.status_code == 504
    assert response.json()["error"] == {
        "code": "UPSTREAM_TIMEOUT",
        "message": "deadline reached before all test rows were predicted",
        "retryable": True,
    }


def test_backend_rejection_maps_to_422(limits, body):
    class Rejecting(FakeBackend):
        def fit_predict(self, **kwargs):
            raise UpstreamRejected("AI Core /predict returned HTTP 413")

    app.dependency_overrides[get_predict_service] = lambda: PredictService(Rejecting(), limits)
    try:
        response = TestClient(app).post("/v1/tabular", json=body)
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 422
    assert response.json()["error"]["retryable"] is False


def test_unexpected_errors_do_not_leak(limits, body):
    class Broken(FakeBackend):
        def fit_predict(self, **kwargs):
            raise KeyError("secret internals")

    app.dependency_overrides[get_predict_service] = lambda: PredictService(Broken(), limits)
    try:
        response = TestClient(app, raise_server_exceptions=False).post("/v1/tabular", json=body)
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 500
    assert response.json()["error"] == {
        "code": "INTERNAL",
        "message": "internal error",
        "retryable": False,
    }


def test_internal_errors_carry_the_correlation_id(limits, body):
    class Broken(FakeBackend):
        def fit_predict(self, **kwargs):
            raise KeyError("secret internals")

    app.dependency_overrides[get_predict_service] = lambda: PredictService(Broken(), limits)
    try:
        response = TestClient(app, raise_server_exceptions=False).post(
            "/v1/tabular", json=body, headers={"X-Correlation-Id": "cid-500"}
        )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 500
    assert response.headers["x-correlation-id"] == "cid-500"
    assert "secret" not in response.text
