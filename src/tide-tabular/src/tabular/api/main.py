from __future__ import annotations

import hmac
import ipaddress
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from tabular.api.deps import (
    get_additional_services,
    get_admission_limiter,
    get_predict_service,
    get_prediction_registry,
)
from tabular.api.logging import (
    BodyLimitMiddleware,
    CatchAllMiddleware,
    CorrelationIdMiddleware,
    _BodyTooLarge,
    configure_logging,
)
from tabular.api.schemas import (
    CapabilitiesDTO,
    CapabilityCatalogueDTO,
    CapabilityExtensionDTO,
    ConfiguredCapabilityLimitsDTO,
    ErrorDTO,
    FitRequestV3DTO,
    HealthDTO,
    LocalLimitsDTO,
    ModelReferenceDTO,
    PredictRequestDTO,
    PredictRequestV3DTO,
    ReleaseRequestDTO,
    ReleaseResultDTO,
    SupportedOutputsDTO,
    TabularResultDTO,
    TabularResultV3DTO,
)
from tabular.application.predict import PredictService
from tabular.application.references import ReferenceCodec
from tabular.domain.capabilities import SDK_OPTION_INVENTORY, SDK_UTILITY_INVENTORY
from tabular.domain.errors import (
    ConfigurationError,
    LimitExceeded,
    ModelReferenceInvalid,
    Overloaded,
    TabularError,
    UnsupportedCapability,
    UpstreamError,
    UpstreamRejected,
    UpstreamTimeout,
    ValidationFailure,
)
from tabular.settings import get_settings

log = logging.getLogger("tabular")

_STATUS = {
    ValidationFailure: 400,
    LimitExceeded: 413,
    UpstreamRejected: 422,
    Overloaded: 429,
    UpstreamError: 502,
    ConfigurationError: 503,
    UpstreamTimeout: 504,
}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Build at startup so a misconfigured backend fails before serving requests.
    service = get_predict_service()
    additional_services: dict[str, PredictService] = {}
    try:
        additional_services = get_additional_services()
        log.info("tabular ready", extra={"fields": {"backend": get_settings().tabular_backend}})
        yield
    finally:
        service.close()
        for additional in additional_services.values():
            additional.close()
        get_additional_services.cache_clear()
        get_predict_service.cache_clear()
        get_admission_limiter.cache_clear()


app = FastAPI(title="tabular", version="0.2.0", lifespan=lifespan)
# Execution order: correlation ID, body limit, then catch-all.
app.add_middleware(CatchAllMiddleware)
app.add_middleware(BodyLimitMiddleware, max_bytes=lambda: get_settings().tabular_max_body_bytes)
app.add_middleware(CorrelationIdMiddleware)


@app.exception_handler(TabularError)
def _tabular_error(request: Request, exc: TabularError) -> JSONResponse:
    status = next((s for t, s in _STATUS.items() if isinstance(exc, t)), 500)
    log.warning("request failed", extra={"fields": {"code": exc.code, "error": str(exc)}})
    headers = {"Retry-After": str(exc.retry_after_s)} if isinstance(exc, Overloaded) else None
    return JSONResponse(
        ErrorDTO.of(exc.code, str(exc), exc.retryable), status_code=status, headers=headers
    )


@app.exception_handler(RequestValidationError)
def _request_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", ()))
    message = f"{where}: {first.get('msg', 'invalid request')}"
    return JSONResponse(ErrorDTO.of("VALIDATION", message, False), status_code=400)


@app.exception_handler(StarletteHTTPException)
def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    if isinstance(exc, _BodyTooLarge):
        return JSONResponse(ErrorDTO.of("LIMIT_EXCEEDED", str(exc.detail), False), status_code=413)
    code = {401: "UNAUTHORIZED", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(
        exc.status_code, "HTTP_ERROR"
    )
    return JSONResponse(ErrorDTO.of(code, str(exc.detail), False), status_code=exc.status_code)


@app.exception_handler(Exception)
def _unexpected(request: Request, exc: Exception) -> JSONResponse:
    log.exception("unexpected error")
    return JSONResponse(ErrorDTO.of("INTERNAL", "internal error", False), status_code=500)


@app.get("/health", response_model=HealthDTO, response_model_exclude_none=True)
def health(service: PredictService = Depends(get_predict_service)) -> HealthDTO:  # noqa: B008
    """Liveness, model backend and non-secret configuration identity."""
    return HealthDTO(status="ok", backend=service.backend_name, identity=service.backend_identity)


@app.get("/v3/capabilities", response_model=CapabilitiesDTO)
def capabilities(
    service: PredictService = Depends(get_predict_service),  # noqa: B008
    registry: dict[str, PredictService] = Depends(get_prediction_registry),  # noqa: B008
) -> CapabilitiesDTO:
    """Versioned adapter support; offline evidence is not live-provider conformance."""
    supported = {
        feature.name for feature in service.catalogue.features if feature.status == "supported"
    }
    return CapabilitiesDTO(
        backend=service.backend_name,
        identity=service.backend_identity,
        prediction_contract_versions=[2, 3],
        verification="synthetic" if service.backend_name == "fake" else "offline-adapter-tests",
        configured_limits=ConfiguredCapabilityLimitsDTO(
            max_test_batch=service.capabilities.max_test_batch,
            max_classes=service.capabilities.max_classes,
        ),
        local_limits=LocalLimitsDTO(**asdict(service.limits)),
        outputs=SupportedOutputsDTO.model_validate(
            {
                "classification": ["labels", "probas"],
                "regression": [
                    name
                    for name in ("mean", "median", "mode", "quantiles", "summary", "distribution")
                    if name in supported
                ],
            }
        ),
        extensions=[
            CapabilityExtensionDTO.model_validate(
                {
                    "name": name,
                    "status": "supported" if name in supported else "unsupported",
                    "provider_status": "synthetic"
                    if service.backend_name == "fake"
                    else "unverified",
                }
            )
            for name in (
                "labels",
                "median",
                "mode",
                "summary",
                "distribution",
                "model_options",
                "thinking",
                "group_time",
                "fit_reuse",
                "kv_cache",
                "remote_jobs",
                "remote_cancel",
            )
        ],
        catalogues=[
            CapabilityCatalogueDTO.model_validate(
                {**asdict(selected.catalogue), "digest": selected.capability_digest}
            )
            for selected in registry.values()
        ],
        sdk_options=SDK_OPTION_INVENTORY,
        sdk_utilities=SDK_UTILITY_INVENTORY,
    )


@app.post("/v1/tabular", response_model=TabularResultDTO)
def predict(
    body: PredictRequestDTO,
    service: PredictService = Depends(get_predict_service),  # noqa: B008
    x_deadline_ms: int | None = Header(default=None, gt=0),  # noqa: B008
    x_backend_identity: str | None = Header(default=None),  # noqa: B008
    authorization: str | None = Header(default=None),  # noqa: B008
) -> TabularResultDTO:
    """`X-Deadline-Ms` bounds worker waiting, relative (no clock sync needed).
    Provider work may outlive it; parsing and preprocessing are not a hard SLA."""
    _require_configured_caller(authorization)
    if x_backend_identity is not None and x_backend_identity != service.backend_identity:
        raise ValidationFailure("model configuration changed before dispatch")
    budget_s = get_settings().tabular_default_deadline_seconds
    if x_deadline_ms is not None:
        budget_s = min(budget_s, x_deadline_ms / 1000)
    result = service.run(body.to_domain(), deadline=time.monotonic() + budget_s)
    log.info(
        "predicted",
        extra={
            "fields": {
                "task": result.task,
                "output_type": result.output_type,
                "train_rows": result.train_rows,
                "test_rows": len(result.predictions),
                "calls": result.usage.calls,
                "fallback": result.fallback,
                "dropped_columns": list(result.dropped_columns),
                "placeholder": result.placeholder,
                "cost_units": result.usage.cost_units,
                "effective_feature_count": result.usage.effective_feature_count,
                "elapsed_ms": round(result.elapsed_ms, 1),
            }
        },
    )
    return TabularResultDTO.of(result)


@app.post("/v3/tabular", response_model=TabularResultV3DTO)
def predict_v3(
    body: PredictRequestV3DTO,
    service: PredictService = Depends(get_predict_service),  # noqa: B008
    registry: dict[str, PredictService] = Depends(get_prediction_registry),  # noqa: B008
    x_deadline_ms: int | None = Header(default=None, gt=0),  # noqa: B008
    x_backend_identity: str | None = Header(default=None),  # noqa: B008
    authorization: str | None = Header(default=None),  # noqa: B008
) -> TabularResultV3DTO:
    _require_configured_caller(authorization)
    selected = registry.get(body.backendKey)
    if selected is None:
        raise UnsupportedCapability("requested provider/model is not enabled")
    service = selected
    if x_backend_identity is not None and x_backend_identity != service.backend_identity:
        raise ValidationFailure("model configuration changed before dispatch")
    budget_s = get_settings().tabular_default_deadline_seconds
    for milliseconds in (x_deadline_ms, body.execution.deadline_ms):
        if milliseconds is not None:
            budget_s = min(budget_s, milliseconds / 1000)
    request = body.to_domain()
    manifest = None
    if body.modelRef is not None:
        _require_internal_caller(authorization)
        manifest = _reference_codec().decode(
            body.modelRef.token,
            backend_key=body.backendKey,
            model_key=body.modelKey,
            identity=service.backend_identity,
        )
        if (
            body.modelRef.backendKey != body.backendKey
            or body.modelRef.modelKey != body.modelKey
            or body.modelRef.configuration_identity != service.backend_identity
        ):
            raise ModelReferenceInvalid("model reference belongs to another configuration")
        result = service.predict_reference_v3(
            request, manifest, deadline=time.monotonic() + budget_s
        )
    else:
        result = service.run_v3(request, deadline=time.monotonic() + budget_s)
    return TabularResultV3DTO.of(
        request,
        result,
        service.backend_identity,
        service.capability_digest,
        service.plan_fingerprint(request, manifest=manifest),
    )


def _require_internal_caller(authorization: str | None) -> None:
    token = get_settings().tabular_internal_token
    if not token:
        raise ConfigurationError("internal model operations are not enabled")
    expected = f"Bearer {token}"
    if authorization is None or not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise StarletteHTTPException(
            status_code=401, detail="internal caller authentication required"
        )


def _require_configured_caller(authorization: str | None) -> None:
    """Unauthenticated inference is only allowed on loopback; see `main`."""
    if get_settings().tabular_internal_token:
        _require_internal_caller(authorization)


def _is_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host == "localhost"


def _reference_codec() -> ReferenceCodec:
    settings = get_settings()
    return ReferenceCodec(
        settings.tabular_model_reference_secret, settings.tabular_model_reference_ttl_seconds
    )


@app.post("/v3/models/fit", response_model=ModelReferenceDTO)
def fit_model_v3(
    body: FitRequestV3DTO,
    registry: dict[str, PredictService] = Depends(get_prediction_registry),  # noqa: B008
    authorization: str | None = Header(default=None),  # noqa: B008
    x_backend_identity: str | None = Header(default=None),  # noqa: B008
    x_deadline_ms: int | None = Header(default=None, gt=0),  # noqa: B008
) -> ModelReferenceDTO:
    _require_internal_caller(authorization)
    codec = _reference_codec()
    service = registry.get(body.backendKey)
    if service is None:
        raise UnsupportedCapability("requested provider/model is not enabled")
    identity = service.backend_identity
    if identity is None:
        raise ConfigurationError("model references require a configuration identity")
    if x_backend_identity is not None and x_backend_identity != service.backend_identity:
        raise ValidationFailure("model configuration changed before dispatch")
    seconds = get_settings().tabular_default_deadline_seconds
    for milliseconds in (x_deadline_ms, body.execution.deadline_ms):
        if milliseconds is not None:
            seconds = min(seconds, milliseconds / 1000)
    manifest = service.fit_v3(
        body.to_domain(), deadline=time.monotonic() + seconds, reference_codec=codec
    )
    token, expires_at = codec.encode(manifest)
    return ModelReferenceDTO(
        backendKey=body.backendKey,
        modelKey=body.modelKey,
        configuration_identity=identity,
        token=token,
        expires_at=expires_at,
    )


@app.post("/v3/models/release", response_model=ReleaseResultDTO)
def release_model_v3(
    body: ReleaseRequestDTO,
    registry: dict[str, PredictService] = Depends(get_prediction_registry),  # noqa: B008
    authorization: str | None = Header(default=None),  # noqa: B008
) -> ReleaseResultDTO:
    _require_internal_caller(authorization)
    service = registry.get(body.modelRef.backendKey)
    if service is None:
        raise ModelReferenceInvalid("model reference provider is not enabled")
    _reference_codec().decode(
        body.modelRef.token,
        backend_key=body.modelRef.backendKey,
        model_key=body.modelRef.modelKey,
        identity=service.backend_identity,
    )
    return ReleaseResultDTO()


def main() -> None:
    import uvicorn

    configure_logging()
    settings = get_settings()
    if not _is_loopback(settings.host) and not settings.tabular_internal_token:
        raise SystemExit(
            "TABULAR_HOST is not loopback; set TABULAR_INTERNAL_TOKEN to authenticate callers"
        )
    uvicorn.run("tabular.api.main:app", host=settings.host, port=settings.port, log_config=None)


if __name__ == "__main__":
    main()
