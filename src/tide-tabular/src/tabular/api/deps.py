"""Wiring: builds the application service from settings, once per process."""

from __future__ import annotations

from functools import lru_cache

from fastapi import Depends

from tabular.application.admission import AdmissionLimiter
from tabular.application.predict import Limits, PredictService
from tabular.domain.ports import TabularBackend
from tabular.infrastructure.backends.fake import FakeBackend
from tabular.settings import AiCoreConfig, PriorLabsConfig, Settings, get_settings


def build_backend(settings: Settings) -> TabularBackend:
    config = settings.require_runtime_config()
    if settings.tabular_backend == "aicore":
        from tabular.infrastructure.backends.aicore import AiCoreBackend

        assert isinstance(config, AiCoreConfig)
        return AiCoreBackend(config)
    if settings.tabular_backend == "priorlabs":
        from tabular.infrastructure.backends.priorlabs import PriorLabsBackend

        assert isinstance(config, PriorLabsConfig)
        return PriorLabsBackend(config)
    return FakeBackend()


def build_limits(settings: Settings) -> Limits:
    return Limits(
        max_context_rows=settings.tabular_max_context_rows,
        max_test_rows=settings.tabular_max_test_rows,
        test_chunk_rows=settings.tabular_test_chunk_rows,
        max_concurrent_calls=settings.tabular_max_concurrent_calls,
        max_columns=settings.tabular_max_columns,
        max_cells=settings.tabular_max_cells,
        max_execution_cells=settings.tabular_max_execution_cells,
        max_levels=settings.tabular_max_quantile_levels,
        min_call_budget_s=settings.tabular_min_call_budget_seconds,
    )


@lru_cache
def get_admission_limiter() -> AdmissionLimiter:
    return AdmissionLimiter(get_settings().tabular_max_concurrent_calls)


@lru_cache
def get_predict_service() -> PredictService:
    settings = get_settings()
    return PredictService(
        backend=build_backend(settings),
        limits=build_limits(settings),
        cache_identity=settings.backend_cache_identity(),
        admission=get_admission_limiter(),
        dry_run_backend=FakeBackend(),
    )


@lru_cache
def get_additional_services() -> dict[str, PredictService]:
    settings = get_settings()
    services: dict[str, PredictService] = {}
    try:
        for backend in settings.tabular_enabled_backends:
            if backend == settings.tabular_backend or backend in services:
                continue
            selected = settings.model_copy(update={"tabular_backend": backend})
            services[backend] = PredictService(
                backend=build_backend(selected),
                limits=build_limits(selected),
                cache_identity=selected.backend_cache_identity(),
                admission=get_admission_limiter(),
                dry_run_backend=FakeBackend(),
            )
    except Exception:
        for service in services.values():
            service.close()
        raise
    return services


def get_prediction_registry(
    default: PredictService = Depends(get_predict_service),  # noqa: B008
) -> dict[str, PredictService]:
    return {**get_additional_services(), default.backend_name: default}
