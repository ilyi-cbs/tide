import threading
import time
from dataclasses import replace

import pytest

from tabular.application.predict import PredictService
from tabular.domain.errors import (
    ClassLimit,
    ConfigurationError,
    LimitExceeded,
    MalformedUpstream,
    ModelReferenceInvalid,
    OutcomeUnknown,
    Overloaded,
    UpstreamError,
    UpstreamTimeout,
    ValidationFailure,
)
from tabular.domain.models import (
    BackendUsage,
    Capabilities,
    ClassProbas,
    ColumnSpec,
    OutputSpec,
    Points,
    PredictRequest,
    PredictRequestV3,
    QuantileGrid,
    RegressionDistribution,
    RegressionSummary,
)
from tabular.infrastructure.backends.fake import FakeBackend

NUM = ColumnSpec("a", "numeric")


def _request(**overrides) -> PredictRequest:
    fields = dict(
        task="regression",
        columns=(NUM,),
        x_train=((1,), (2,), (3,)),
        y_train=(1.0, 2.0, 3.0),
        keys=("k1", "k2", "k3"),
        x_test=((4,), (5,), (6,)),
        output=OutputSpec("point"),
    )
    fields.update(overrides)
    return PredictRequest(**fields)


class RecordingBackend(FakeBackend):
    def __init__(self, capabilities: Capabilities | None = None) -> None:
        self.calls: list[dict] = []
        if capabilities:
            self.capabilities = capabilities

    def fit_predict(self, **kwargs):
        self.calls.append(kwargs)
        return super().fit_predict(**kwargs)


def _later(seconds: float = 30) -> float:
    return time.monotonic() + seconds


class NativeBackend(RecordingBackend):
    def __init__(self):
        super().__init__()
        self.fits = 0
        self.restores = 0

    def fit(self, **kwargs):
        self.fits += 1
        return self

    def restore(self, record, **kwargs):
        self.restores += 1
        return self

    def export(self):
        return {"model_id": "fit-1", "n_train_rows": 3, "classes": None, "params": {}}

    def predict(self, rows, *, output, timeout_s):
        self.calls.append(rows)
        return Points((2.0,) * len(rows))


def _native_request(**overrides):
    return PredictRequestV3(_request(**overrides), "fake", "default", "point")


def test_native_fit_execution_limit_precedes_provider(limits):
    backend = NativeBackend()
    service = PredictService(backend, replace(limits, max_execution_cells=5))
    try:
        with pytest.raises(LimitExceeded):
            service.fit_v3(_native_request(), deadline=_later())
        assert backend.fits == 0
    finally:
        service.close()


def test_native_prediction_accounts_for_one_fit(limits):
    backend = NativeBackend()
    service = PredictService(backend, replace(limits, max_execution_cells=9))
    try:
        result = service.run_v3(_native_request(), deadline=_later())
        assert backend.fits == 1
        assert result.usage.context_cells == 6
        assert result.usage.predicted_cells == 3
    finally:
        service.close()


def test_reference_budget_precedes_restore(limits):
    backend = NativeBackend()
    service = PredictService(backend, replace(limits, max_execution_cells=2))
    manifest = {
        "task": "regression",
        "columns": [{"name": "a", "kind": "numeric"}],
        "record": backend.export(),
    }
    try:
        with pytest.raises(LimitExceeded):
            service.predict_reference_v3(
                _native_request(x_train=(), y_train=()), manifest, deadline=_later()
            )
        assert backend.restores == 0
    finally:
        service.close()


def test_reference_fingerprint_binds_fit_not_expiry(limits):
    service = PredictService(NativeBackend(), limits)
    request = _native_request(x_train=(), y_train=())
    manifest = {
        "record": {"model_id": "fit-1"},
        "training_fingerprint": "training",
        "expires_at": 100,
        "version": 1,
    }
    try:
        first = service.plan_fingerprint(request, manifest=manifest)
        assert first == service.plan_fingerprint(request, manifest={**manifest, "expires_at": 200})
        assert first != service.plan_fingerprint(
            request, manifest={**manifest, "record": {"model_id": "fit-2"}}
        )
    finally:
        service.close()


@pytest.mark.parametrize("metadata", [{"coordinates": "latent"}, {"tails": "invented"}])
def test_distribution_metadata_is_malformed_upstream(metadata):
    from tabular.application.predict import _to_predictions

    summary = RegressionSummary((1.0,), (1.0,), (1.0,), (), ((),))
    output = RegressionDistribution(summary, (0.0, 2.0), ((0.0,),), ((False,),), **metadata)
    with pytest.raises(MalformedUpstream):
        _to_predictions(("key",), output, OutputSpec("distribution"))


def _manifest():
    return {
        "backendKey": "priorlabs",
        "modelKey": "default",
        "configuration_identity": "account",
        "task": "regression",
        "columns": [{"name": "a", "kind": "numeric"}],
        "feature_indices": [0],
        "training_fingerprint": "a" * 64,
        "model_options": {},
        "fit_options": {},
        "record": {
            "tabpfn_client_version": "0.6.0",
            "task": "regression",
            "model_id": "00000000-0000-0000-0000-000000000001",
            "params": {},
            "n_train_rows": 3,
            "classes": None,
        },
    }


def test_reference_codec_roundtrip_expiry_and_binding(monkeypatch):
    from tabular.application.references import ReferenceCodec

    clock = [100.0]
    monkeypatch.setattr("tabular.application.references.time.time", lambda: clock[0])
    codec = ReferenceCodec("s" * 32, 10)
    token, expiry = codec.encode(_manifest())
    assert expiry == 110
    assert (
        codec.decode(token, backend_key="priorlabs", model_key="default", identity="account")[
            "record"
        ]
        == _manifest()["record"]
    )
    for backend, model, identity in [
        ("fake", "default", "account"),
        ("priorlabs", "other", "account"),
        ("priorlabs", "default", "other"),
    ]:
        with pytest.raises(ModelReferenceInvalid):
            codec.decode(token, backend_key=backend, model_key=model, identity=identity)
    clock[0] = 110.0
    with pytest.raises(ModelReferenceInvalid):
        codec.decode(token, backend_key="priorlabs", model_key="default", identity="account")


@pytest.mark.parametrize("token", ["raw-provider-id", "a.bad", "x" * 131073])
def test_reference_codec_rejects_invalid_tokens(token):
    from tabular.application.references import ReferenceCodec

    with pytest.raises(ModelReferenceInvalid):
        ReferenceCodec("s" * 32, 10).decode(
            token, backend_key="priorlabs", model_key="default", identity="account"
        )


@pytest.mark.parametrize(
    "mutation",
    [
        {"n_train_rows": True},
        {"n_train_rows": 0},
        {"task": "classification"},
        {"model_id": "raw-id"},
        {"tabpfn_client_version": "unknown"},
        {"params": {"client_options": {"headers": {"Authorization": "secret"}}}},
        {"params": {"api_key": "secret"}},
        {"x_train": [[1]]},
        {"classes": ["a"]},
    ],
)
def test_reference_export_rejects_unsafe_record(mutation):
    from tabular.application.references import ReferenceCodec

    manifest = _manifest()
    manifest["record"].update(mutation)
    with pytest.raises(ModelReferenceInvalid):
        ReferenceCodec("s" * 32, 10).encode(manifest)


@pytest.mark.parametrize("operation", ["fit", "reference"])
def test_model_timeout_retains_capacity_until_worker_finishes(limits, operation):
    entered = threading.Event()
    release = threading.Event()

    class BlockingBackend(NativeBackend):
        def fit(self, **kwargs):
            entered.set()
            assert release.wait(5)
            return super().fit(**kwargs)

        def restore(self, record, **kwargs):
            entered.set()
            assert release.wait(5)
            return super().restore(record, **kwargs)

    backend = BlockingBackend()
    service = PredictService(backend, replace(limits, max_concurrent_calls=1, min_call_budget_s=0))
    try:
        with pytest.raises(OutcomeUnknown):
            if operation == "fit":
                service.fit_v3(_native_request(), deadline=_later(0.05))
            else:
                manifest = _manifest()
                manifest["record"] = backend.export()
                service.predict_reference_v3(
                    _native_request(x_train=(), y_train=()), manifest, deadline=_later(0.05)
                )
        assert entered.is_set()
        with pytest.raises(Overloaded):
            service.fit_v3(_native_request(), deadline=_later())
    finally:
        release.set()
        service.close()
    assert service._slots.acquire(blocking=False)
    service._slots.release()
    with pytest.raises(ConfigurationError):
        service.fit_v3(_native_request(), deadline=_later())


def test_close_is_idempotent_and_rejects_new_work(limits):
    closed = []

    class OwnedBackend(FakeBackend):
        def close(self):
            closed.append(True)

    service = PredictService(OwnedBackend(), limits)
    service.run(_request(), deadline=_later())
    service.close()
    service.close()
    assert closed == [True]
    with pytest.raises(ConfigurationError):
        service.run(_request(), deadline=_later())


def test_worker_preserves_correlation_context(limits):
    from tabular.api.logging import correlation_id

    seen = []

    class ContextBackend(FakeBackend):
        def fit_predict(self, **kwargs):
            seen.append(correlation_id.get())
            return super().fit_predict(**kwargs)

    token = correlation_id.set("test-worker-context")
    try:
        PredictService(ContextBackend(), limits).run(_request(), deadline=_later())
    finally:
        correlation_id.reset(token)
    assert seen == ["test-worker-context", "test-worker-context"]


def test_failed_submission_releases_admission_exactly_once(limits, monkeypatch):
    service = PredictService(FakeBackend(), replace(limits, max_concurrent_calls=1))

    def failed_submit(*args, **kwargs):
        raise RuntimeError("executor unavailable")

    with monkeypatch.context() as patch:
        patch.setattr(service._executor, "submit", failed_submit)
        with pytest.raises(RuntimeError, match="executor unavailable"):
            service.run(_request(), deadline=_later())
    assert len(service.run(_request(), deadline=_later()).predictions) == 3


def test_busy_capacity_rejects_before_preprocessing(limits, monkeypatch):
    from tabular.application import predict as module

    service = PredictService(RecordingBackend(), replace(limits, max_concurrent_calls=1))
    assert service._slots.acquire(blocking=False)

    def unexpected_preprocessing(request):
        pytest.fail("overloaded work must not copy or scan prediction inputs")

    monkeypatch.setattr(module, "_varying", unexpected_preprocessing)
    try:
        with pytest.raises(Overloaded):
            service.run(_request(), deadline=_later())
    finally:
        service._slots.release()
        service.close()


@pytest.mark.parametrize("mode", ["predict", "dry_run"])
def test_expired_work_rejects_before_preprocessing(limits, monkeypatch, mode):
    from tabular.application import predict as module

    backend = RecordingBackend()
    service = PredictService(backend, limits)

    def unexpected_preprocessing(request):
        pytest.fail("expired work must not copy or scan prediction inputs")

    monkeypatch.setattr(module, "_varying", unexpected_preprocessing)
    try:
        with pytest.raises(UpstreamTimeout):
            service.run(_request(mode=mode), deadline=time.monotonic() - 1)
        assert not backend.calls
    finally:
        service.close()


@pytest.mark.parametrize("mode", ["predict", "dry_run"])
def test_execution_budget_boundary_and_fallback(limits, mode):
    backend = RecordingBackend()
    request = _request(mode=mode)
    result = PredictService(backend, replace(limits, max_execution_cells=15)).run(
        request, deadline=_later()
    )
    assert result.usage.context_cells + result.usage.predicted_cells == 15
    with pytest.raises(LimitExceeded):
        PredictService(backend, replace(limits, max_execution_cells=14)).run(
            request, deadline=_later()
        )
    fallback = PredictService(backend, replace(limits, max_execution_cells=1)).run(
        replace(request, x_train=((1,), (1,), (1,))), deadline=_later()
    )
    assert fallback.usage.calls == 0


@pytest.mark.parametrize(
    "classes, vector",
    [
        (("a", "a"), (0.5, 0.5)),
        (("a", "b"), (-0.1, 1.1)),
        (("a", "b"), (0.2, 0.2)),
        (("a", "b"), (True, False)),
        (("a", "b"), (float("nan"), 0.5)),
        (("a", "b"), (0.5,)),
    ],
)
def test_invalid_probabilities_are_nonretryable(limits, classes, vector):
    class InvalidBackend(FakeBackend):
        def fit_predict(self, **kwargs):
            return ClassProbas(classes=classes, scores=(vector,) * len(kwargs["x_test"]))

    request = _request(task="classification", y_train=("a", "b", "a"), output=OutputSpec("probas"))
    with pytest.raises(MalformedUpstream) as error:
        PredictService(InvalidBackend(), limits).run(request, deadline=_later())
    assert not error.value.retryable


def test_equal_quantiles_preserve_original_association(limits):
    class EqualBackend(FakeBackend):
        def fit_predict(self, **kwargs):
            return QuantileGrid(
                levels=kwargs["output"].levels, values=((2.0, 2.0, 2.0),) * len(kwargs["x_test"])
            )

    result = PredictService(EqualBackend(), limits).run(
        _request(output=OutputSpec("quantiles", (0.1, 0.9))), deadline=_later()
    )
    assert all(
        prediction.value == 2 and prediction.quantiles == (2, 2)
        for prediction in result.predictions
    )


def test_trains_once_per_chunk_and_keeps_key_order(limits):
    backend = RecordingBackend()
    result = PredictService(backend, limits).run(_request(), deadline=_later())
    assert [p.row_key for p in result.predictions] == ["k1", "k2", "k3"]
    assert result.train_rows == 3
    # chunk size 2: two backend calls, each with the full training context
    assert [len(c["x_test"]) for c in backend.calls] == [2, 1]
    assert all(len(c["x_train"]) == 3 for c in backend.calls)
    assert result.usage.calls == 2
    assert result.usage.backend == "fake"


def test_chunks_never_exceed_the_backend_batch(limits):
    backend = RecordingBackend(Capabilities(max_test_batch=1, max_classes=10))
    PredictService(backend, limits).run(_request(), deadline=_later())
    assert [len(c["x_test"]) for c in backend.calls] == [1, 1, 1]


@pytest.mark.parametrize(
    "overrides",
    [
        dict(x_train=()),
        dict(y_train=(1.0, 2.0)),
        dict(keys=("k1", "k1", "k3")),
        dict(keys=("k1", "", "k3")),
        dict(keys=("k1",)),
        dict(x_test=((4, 5), (5,), (6,))),
        dict(y_train=(1.0, None, 3.0)),
        dict(y_train=("a", "b", "c")),
        dict(y_train=(True, 2.0, 3.0)),
        dict(y_train=(float("nan"), 2.0, 3.0)),
        dict(x_train=((1,), (float("inf"),), (3,))),
        dict(x_train=((1,), ("text",), (3,))),
        dict(x_train=((1,), (True,), (3,))),
        dict(columns=(NUM, NUM), x_train=((1, 1),) * 3, x_test=((1, 1),) * 3),
        dict(output=OutputSpec("probas")),
        dict(task="classification", y_train=("a", "b", "a")),
        dict(output=OutputSpec("quantiles")),
        dict(output=OutputSpec("quantiles", (0.9, 0.1))),
        dict(output=OutputSpec("quantiles", (0.1, 0.1))),
        dict(output=OutputSpec("quantiles", (0.0, 0.5))),
        dict(output=OutputSpec("point", (0.5,))),
    ],
)
def test_rejects_invalid_requests(limits, overrides):
    with pytest.raises(ValidationFailure):
        PredictService(FakeBackend(), limits).run(_request(**overrides), deadline=_later())


def test_limits_answer_limit_exceeded(limits):
    service = PredictService(FakeBackend(), limits)
    too_many = dict(x_train=tuple((i,) for i in range(101)), y_train=tuple(range(101)))
    with pytest.raises(LimitExceeded):
        service.run(_request(**too_many), deadline=_later())


def test_more_classes_than_the_backend_supports_is_class_limit(limits):
    backend = RecordingBackend(Capabilities(max_test_batch=10, max_classes=2))
    request = _request(task="classification", y_train=("a", "b", "c"), output=OutputSpec("probas"))
    with pytest.raises(ClassLimit) as info:
        PredictService(backend, limits).run(request, deadline=_later())
    assert info.value.code == "CLASS_LIMIT"


def test_stops_when_the_deadline_is_reached(limits):
    backend = RecordingBackend()
    with pytest.raises(UpstreamTimeout):
        PredictService(backend, limits).run(_request(), deadline=_later(0.5))
    assert backend.calls == []


def test_passes_the_remaining_budget_to_the_backend(limits):
    backend = RecordingBackend()
    PredictService(backend, limits).run(_request(), deadline=_later(10))
    assert all(0 < c["timeout_s"] <= 10 for c in backend.calls)


def test_constant_columns_are_dropped_before_the_backend(limits):
    backend = RecordingBackend()
    request = _request(
        columns=(NUM, ColumnSpec("plant", "categorical")),
        x_train=((1, "P1"), (2, "P1"), (3, "P1")),
        x_test=((4, "P1"), (5, "P2"), (6, None)),
    )
    result = PredictService(backend, limits).run(request, deadline=_later())
    assert result.dropped_columns == ("plant",)
    assert [c.name for c in backend.calls[0]["columns"]] == ["a"]
    assert backend.calls[0]["x_test"] == [[4], [5]]


def test_no_varying_column_answers_the_context_without_a_model_call(limits):
    backend = RecordingBackend()
    request = _request(
        x_train=((1,), (1,), (1,)),
        output=OutputSpec("quantiles", (0.1, 0.9)),
        y_train=(10.0, 20.0, 30.0),
    )
    result = PredictService(backend, limits).run(request, deadline=_later())
    assert backend.calls == []
    assert result.fallback == "context_quantiles"
    assert result.usage.calls == 0 and result.usage.cost_units == 0
    assert result.predictions[0].quantiles == (12.0, 28.0)
    assert result.predictions[0].value == 20.0


def test_classification_fallback_is_the_class_distribution(limits):
    request = _request(
        task="classification",
        x_train=((1,), (1,), (1,)),
        y_train=("a", "b", "a"),
        output=OutputSpec("probas"),
    )
    result = PredictService(RecordingBackend(), limits).run(request, deadline=_later())
    assert result.fallback == "context_distribution"
    assert result.classes == ("a", "b")
    assert result.predictions[0].value == "a"
    assert result.predictions[0].probabilities == pytest.approx((2 / 3, 1 / 3))


def test_single_class_answers_that_class_without_a_model_call(limits):
    backend = RecordingBackend()
    request = _request(task="classification", y_train=("a", "a", "a"), output=OutputSpec("probas"))
    result = PredictService(backend, limits).run(request, deadline=_later())
    assert backend.calls == []
    assert result.fallback == "context_distribution"
    assert result.classes == ("a",)
    assert {p.value for p in result.predictions} == {"a"}
    assert result.predictions[0].probabilities == (1.0,)


def test_constant_regression_target_answers_the_constant(limits):
    backend = RecordingBackend()
    request = _request(y_train=(7.0, 7.0, 7.0), output=OutputSpec("quantiles", (0.1, 0.9)))
    result = PredictService(backend, limits).run(request, deadline=_later())
    assert backend.calls == []
    assert result.fallback == "context_quantiles"
    assert result.predictions[0].quantiles == (7.0, 7.0)


def test_single_training_row_regression_falls_back(limits):
    request = _request(x_train=((1,),), y_train=(5.0,), output=OutputSpec("point"))
    result = PredictService(RecordingBackend(), limits).run(request, deadline=_later())
    assert result.fallback == "context_distribution"
    assert {p.value for p in result.predictions} == {5.0}


def test_quantile_value_is_the_median_even_when_not_requested(limits):
    backend = RecordingBackend()
    request = _request(output=OutputSpec("quantiles", (0.1, 0.9)), y_train=(10.0, 20.0, 30.0))
    result = PredictService(backend, limits).run(request, deadline=_later())
    assert backend.calls[0]["output"].levels == (0.1, 0.5, 0.9)
    first = result.predictions[0]
    assert first.quantiles == (12.0, 28.0)
    assert first.value == 20.0
    assert result.levels == (0.1, 0.9)


def test_crossed_quantiles_are_rejected_without_retry(limits):
    class Unsorted(FakeBackend):
        def fit_predict(self, *, x_test, output, **kwargs):
            # levels (0.1, 0.5, 0.9) returned out of order per row
            return QuantileGrid(levels=output.levels, values=tuple((9.0, 1.0, 5.0) for _ in x_test))

    request = _request(output=OutputSpec("quantiles", (0.1, 0.9)))
    with pytest.raises(UpstreamError) as error:
        PredictService(Unsorted(), limits).run(request, deadline=_later())
    assert error.value.retryable is False


def test_wrong_row_count_from_the_backend_is_an_upstream_error(limits):
    class Short(FakeBackend):
        def fit_predict(self, **kwargs):
            return Points(points=(1.0,))

    with pytest.raises(UpstreamError):
        PredictService(Short(), limits).run(_request(), deadline=_later())


def test_dry_run_calls_no_backend_and_estimates_usage(limits):
    backend = RecordingBackend()
    result = PredictService(backend, limits).run(_request(mode="dry_run"), deadline=_later())
    assert backend.calls == []
    assert result.placeholder is True
    assert result.usage.calls == 2
    # context: 3 rows x (1 feature + target) per call; predicted: 3 rows x 1 feature
    assert result.usage.context_cells == 12
    assert result.usage.predicted_cells == 3
    assert result.usage.cost_units == pytest.approx(1.05e-6 * 12 + 1.45e-4 * 3)


def test_backend_reported_usage_is_summed(limits):
    class Reporting(FakeBackend):
        def fit_predict(self, *, x_test, **kwargs):
            return Points(
                points=tuple(1.0 for _ in x_test),
                usage=BackendUsage(num_cells=10, num_predictions=len(x_test)),
            )

    result = PredictService(Reporting(), limits).run(_request(), deadline=_later())
    assert result.usage.num_cells == 20
    assert result.usage.num_predictions == 3
    assert result.placeholder is False


def test_rejects_when_all_slots_are_busy(limits):
    release = threading.Event()
    entered = threading.Barrier(limits.max_concurrent_calls + 1)

    class BlockingBackend(FakeBackend):
        def fit_predict(self, **kwargs):
            entered.wait(timeout=5)
            release.wait(timeout=5)
            return Points(points=tuple(0.0 for _ in kwargs["x_test"]))

    service = PredictService(BlockingBackend(), limits)
    # one chunk per request, so each worker reaches the barrier exactly once
    one_chunk = _request(keys=("k1",), x_test=((4,),))
    workers = [
        threading.Thread(target=service.run, args=(one_chunk,), kwargs={"deadline": _later()})
        for _ in range(limits.max_concurrent_calls)
    ]
    for w in workers:
        w.start()
    entered.wait(timeout=5)
    try:
        with pytest.raises(Overloaded):
            service.run(one_chunk, deadline=_later())
    finally:
        release.set()
        for w in workers:
            w.join()


def test_timed_out_worker_retains_capacity(limits):
    release = threading.Event()

    class Blocked(FakeBackend):
        def fit_predict(self, **kwargs):
            release.wait(timeout=5)
            return Points(points=(1.0,))

    service = PredictService(Blocked(), replace(limits, max_concurrent_calls=1))
    request = _request(keys=("one",), x_test=((4,),))
    try:
        with pytest.raises(UpstreamTimeout) as error:
            service.run(request, deadline=_later(1.1))
        assert error.value.retryable is False
        with pytest.raises(Overloaded):
            service.run(request, deadline=_later())
    finally:
        release.set()
        if hasattr(service, "close"):
            service.close()


def test_execution_budget_counts_repeated_context(limits):
    backend = RecordingBackend()
    service = PredictService(backend, replace(limits, max_execution_cells=14))
    with pytest.raises(LimitExceeded):
        service.run(_request(), deadline=_later())
    assert backend.calls == []
