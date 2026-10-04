"""Wire DTOs for POST /v1/tabular (docs/api/tabular.v2.md). Pydantic validates
shape; the application layer validates content and limits. Converters build
the framework-free domain request and the response body.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, model_validator

from tabular.domain.errors import MalformedUpstream
from tabular.domain.models import (
    ColumnSpec,
    OutputSpec,
    PredictRequest,
    PredictRequestV3,
    TabularResult,
)

Cell = str | int | float | bool | None


def _summary_value(value: float | None) -> float:
    if value is None:
        raise MalformedUpstream("backend returned an incomplete summary")
    return value


class ColumnDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    kind: Literal["numeric", "categorical", "text"]


class OutputDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["probas", "point", "quantiles"]
    levels: list[float] | None = None


class PredictRequestDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task: Literal["classification", "regression"]
    mode: Literal["predict", "dry_run"] = "predict"
    columns: list[ColumnDTO] = Field(min_length=1)
    x_train: list[list[Cell]]
    y_train: list[Cell]
    keys: list[str]
    x_test: list[list[Cell]]
    output: OutputDTO

    def to_domain(self) -> PredictRequest:
        return PredictRequest(
            task=self.task,
            mode=self.mode,
            columns=tuple(ColumnSpec(c.name, c.kind) for c in self.columns),
            x_train=tuple(tuple(row) for row in self.x_train),
            y_train=tuple(self.y_train),
            keys=tuple(self.keys),
            x_test=tuple(tuple(row) for row in self.x_test),
            output=OutputSpec(self.output.type, tuple(self.output.levels or ())),
        )


class PredictionDTO(BaseModel):
    row_key: str
    value: str | float
    probabilities: list[float] | None = None
    quantiles: list[float] | None = None


class InferenceConfigDTO(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    SUBSAMPLE_SAMPLES: int | None = Field(default=None, ge=1)


class ModelOptionsDTO(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    n_estimators: int | None = Field(default=None, ge=1)
    random_state: int | None = None
    softmax_temperature: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    balance_probabilities: bool | None = None
    average_before_softmax: bool | None = None
    inference_precision: Literal["auto", "autocast"] | None = None
    inference_config: InferenceConfigDTO | None = None
    ignore_pretraining_limits: bool | None = None
    paper_version: bool | None = None


class FitOptionsDTO(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    thinking_mode: bool | None = None
    thinking_effort: Literal["medium", "high"] | None = None
    fit_timeout: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    thinking_metric: str | None = Field(default=None, min_length=1, max_length=128)
    fit_mode: Literal["fit_preprocessors", "fit_with_cache"] | None = None
    group_columns: list[str] | None = None
    time_column: str | None = None
    grouped_time_column: str | None = None


class OutputV3DTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["labels", "probas", "point", "quantiles", "summary", "distribution"]
    statistic: Literal["mean", "median", "mode"] = "mean"
    levels: list[float] | None = None


class ExecutionDTO(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    deadline_ms: int | None = Field(default=None, gt=0)
    policy: Literal["no_replay"] = "no_replay"


class ModelReferenceDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    backendKey: str
    modelKey: str
    configuration_identity: str
    token: str = Field(min_length=1, max_length=131072)
    expires_at: int | None = None


class PredictRequestV3DTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task: Literal["classification", "regression"]
    mode: Literal["predict", "dry_run"] = "predict"
    backendKey: Literal["fake", "priorlabs", "aicore"]
    modelKey: str = Field(min_length=1, max_length=128)
    columns: list[ColumnDTO] = Field(min_length=1)
    x_train: list[list[Cell]] = Field(default_factory=list)
    y_train: list[Cell] = Field(default_factory=list)
    keys: list[str]
    x_test: list[list[Cell]]
    modelOptions: ModelOptionsDTO = Field(default_factory=ModelOptionsDTO)
    fitOptions: FitOptionsDTO = Field(default_factory=FitOptionsDTO)
    output: OutputV3DTO
    modelRef: ModelReferenceDTO | None = None
    execution: ExecutionDTO = Field(default_factory=ExecutionDTO)

    @model_validator(mode="after")
    def check_training_source(self) -> PredictRequestV3DTO:
        if self.modelRef is not None and (self.x_train or self.y_train):
            raise ValueError("modelRef and training rows are mutually exclusive")
        return self

    def to_domain(self) -> PredictRequestV3:
        model_options = self.modelOptions.model_dump(exclude_none=True, exclude_unset=True)
        if "random_state" in self.modelOptions.model_fields_set:
            model_options["random_state"] = self.modelOptions.random_state
        output_type = "probas" if self.output.type == "labels" else self.output.type
        dataset = PredictRequest(
            task=self.task,
            mode=self.mode,
            columns=tuple(ColumnSpec(column.name, column.kind) for column in self.columns),
            x_train=tuple(tuple(row) for row in self.x_train),
            y_train=tuple(self.y_train),
            keys=tuple(self.keys),
            x_test=tuple(tuple(row) for row in self.x_test),
            output=OutputSpec(
                output_type if output_type in ("probas", "point", "quantiles") else "point",
                tuple(
                    self.output.levels
                    if self.output.levels is not None
                    else [0.1, 0.5, 0.9]
                    if self.output.type in ("summary", "distribution")
                    else ()
                ),
            ),
        )
        return PredictRequestV3(
            dataset=dataset,
            backend_key=self.backendKey,
            model_key=self.modelKey,
            output_type=self.output.type,
            statistic=self.output.statistic,
            model_options=tuple(model_options.items()),
            fit_options=tuple(self.fitOptions.model_dump(exclude_none=True).items()),
        )


class LabelsPayloadDTO(BaseModel):
    type: Literal["labels"] = "labels"
    keys: list[str]
    classes: list[str]
    values: list[str]


class FitRequestV3DTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task: Literal["classification", "regression"]
    backendKey: Literal["fake", "priorlabs", "aicore"]
    modelKey: str = Field(min_length=1, max_length=128)
    columns: list[ColumnDTO] = Field(min_length=1)
    x_train: list[list[Cell]] = Field(min_length=1)
    y_train: list[Cell] = Field(min_length=1)
    modelOptions: ModelOptionsDTO = Field(default_factory=ModelOptionsDTO)
    fitOptions: FitOptionsDTO = Field(default_factory=FitOptionsDTO)
    execution: ExecutionDTO = Field(default_factory=ExecutionDTO)

    def to_domain(self) -> PredictRequestV3:
        return PredictRequestV3DTO(
            **self.model_dump(exclude={"execution"}, exclude_unset=True),
            keys=["fit-validation"],
            x_test=[self.x_train[0]],
            output=OutputV3DTO(type="probas" if self.task == "classification" else "point"),
        ).to_domain()


class ReleaseRequestDTO(BaseModel):
    model_config = ConfigDict(extra="forbid")

    modelRef: ModelReferenceDTO


class ReleaseResultDTO(BaseModel):
    status: Literal["unsupported"] = "unsupported"
    released: Literal[False] = False


class ProbasPayloadDTO(BaseModel):
    type: Literal["probas"] = "probas"
    keys: list[str]
    classes: list[str]
    values: list[list[float]]


class PointPayloadDTO(BaseModel):
    type: Literal["point"] = "point"
    keys: list[str]
    statistic: Literal["mean", "median", "mode"]
    values: list[float]


class QuantilesPayloadDTO(BaseModel):
    type: Literal["quantiles"] = "quantiles"
    keys: list[str]
    levels: list[float]
    values: list[list[float]]


class SummaryPayloadDTO(BaseModel):
    type: Literal["summary"] = "summary"
    keys: list[str]
    means: list[float]
    medians: list[float]
    modes: list[float]
    levels: list[float]
    quantiles: list[list[float]]


class DistributionChunkDTO(BaseModel):
    keys: list[str]
    bucket_borders: list[float]
    logits: list[list[float | None]]
    masked_logits: list[list[bool]]
    coordinates: Literal["target"]
    tails: Literal["full_support", "bounded_synthetic"]


class DistributionPayloadDTO(BaseModel):
    type: Literal["distribution"] = "distribution"
    keys: list[str]
    summary: SummaryPayloadDTO
    chunks: list[DistributionChunkDTO]


BasicPayloadDTO = Annotated[
    LabelsPayloadDTO
    | ProbasPayloadDTO
    | PointPayloadDTO
    | QuantilesPayloadDTO
    | SummaryPayloadDTO
    | DistributionPayloadDTO,
    Field(discriminator="type"),
]


class UsageDTO(BaseModel):
    backend: str
    calls: int
    context_cells: int
    predicted_cells: int
    cost_units: float
    effective_feature_count: int
    num_cells: int | None = None
    num_predictions: int | None = None
    model_version: str | None = None


class TabularResultV3DTO(BaseModel):
    contract_version: Literal[3] = 3
    backendKey: str
    modelKey: str
    configuration_identity: str | None
    capability_digest: str
    plan_fingerprint: str
    diagnostics: dict[str, Any]
    payload: BasicPayloadDTO
    fallback: str | None
    dropped_columns: list[str]
    placeholder: bool
    usage: UsageDTO
    train_rows: int
    elapsed_ms: float

    @classmethod
    def of(
        cls,
        request: PredictRequestV3,
        result: TabularResult,
        identity: str | None,
        capability_digest: str,
        plan_fingerprint: str,
    ) -> TabularResultV3DTO:
        keys = [prediction.row_key for prediction in result.predictions]
        payload: BasicPayloadDTO
        if request.output_type == "labels":
            payload = LabelsPayloadDTO(
                keys=keys,
                classes=list(result.classes or ()),
                values=[str(prediction.value) for prediction in result.predictions],
            )
        elif request.output_type == "probas":
            payload = ProbasPayloadDTO(
                keys=keys,
                classes=list(result.classes or ()),
                values=[list(prediction.probabilities or ()) for prediction in result.predictions],
            )
        elif request.output_type == "quantiles":
            payload = QuantilesPayloadDTO(
                keys=keys,
                levels=list(result.levels or ()),
                values=[list(prediction.quantiles or ()) for prediction in result.predictions],
            )
        elif request.output_type in ("summary", "distribution"):
            summary = SummaryPayloadDTO(
                keys=keys,
                means=[_summary_value(prediction.mean) for prediction in result.predictions],
                medians=[_summary_value(prediction.median) for prediction in result.predictions],
                modes=[_summary_value(prediction.mode) for prediction in result.predictions],
                levels=list(result.levels or ()),
                quantiles=[list(prediction.quantiles or ()) for prediction in result.predictions],
            )
            if request.output_type == "summary":
                payload = summary
            else:
                payload = DistributionPayloadDTO(
                    keys=keys,
                    summary=summary,
                    chunks=[
                        DistributionChunkDTO(
                            keys=list(chunk.keys),
                            bucket_borders=list(chunk.distribution.borders),
                            logits=[list(row) for row in chunk.distribution.logits],
                            masked_logits=[list(row) for row in chunk.distribution.masked_logits],
                            coordinates=chunk.distribution.coordinates,
                            tails=chunk.distribution.tails,
                        )
                        for chunk in result.distributions
                    ],
                )
        else:
            payload = PointPayloadDTO(
                keys=keys,
                statistic=request.statistic,
                values=[float(prediction.value) for prediction in result.predictions],
            )
        return cls(
            backendKey=request.backend_key,
            modelKey=request.model_key,
            configuration_identity=identity,
            capability_digest=capability_digest,
            plan_fingerprint=plan_fingerprint,
            diagnostics={
                "server_defaults": "unknown unless reported by the provider",
                "model_identity_kind": "synthetic"
                if request.backend_key == "fake"
                else "configured-mutable-alias",
                **result.diagnostics,
            },
            payload=payload,
            fallback=result.fallback,
            dropped_columns=list(result.dropped_columns),
            placeholder=result.placeholder or request.backend_key == "fake",
            usage=UsageDTO(**result.usage.__dict__),
            train_rows=result.train_rows,
            elapsed_ms=result.elapsed_ms,
        )


class TabularResultDTO(BaseModel):
    task: Literal["classification", "regression"]
    output_type: Literal["probas", "point", "quantiles"]
    classes: list[str] | None = None
    levels: list[float] | None = None
    predictions: list[PredictionDTO]
    fallback: Literal["context_distribution", "context_quantiles"] | None = None
    dropped_columns: list[str]
    placeholder: bool
    usage: UsageDTO
    train_rows: int
    elapsed_ms: float

    @classmethod
    def of(cls, result: TabularResult) -> TabularResultDTO:
        if result.output_type not in ("probas", "point", "quantiles"):
            raise MalformedUpstream("backend returned a non-V2 output")
        output_type = cast(Literal["probas", "point", "quantiles"], result.output_type)
        u = result.usage
        return cls(
            task=result.task,
            output_type=output_type,
            classes=list(result.classes) if result.classes is not None else None,
            levels=list(result.levels) if result.levels is not None else None,
            predictions=[
                PredictionDTO(
                    row_key=p.row_key,
                    value=p.value,
                    probabilities=list(p.probabilities) if p.probabilities is not None else None,
                    quantiles=list(p.quantiles) if p.quantiles is not None else None,
                )
                for p in result.predictions
            ],
            fallback=result.fallback,
            dropped_columns=list(result.dropped_columns),
            placeholder=result.placeholder,
            usage=UsageDTO(
                backend=u.backend,
                calls=u.calls,
                context_cells=u.context_cells,
                predicted_cells=u.predicted_cells,
                cost_units=u.cost_units,
                effective_feature_count=u.effective_feature_count,
                num_cells=u.num_cells,
                num_predictions=u.num_predictions,
                model_version=u.model_version,
            ),
            train_rows=result.train_rows,
            elapsed_ms=result.elapsed_ms,
        )


class HealthDTO(BaseModel):
    status: Literal["ok"]
    backend: str
    identity: str | None = None


class ConfiguredCapabilityLimitsDTO(BaseModel):
    max_test_batch: int = Field(gt=0)
    max_classes: int = Field(gt=0)


class LocalLimitsDTO(BaseModel):
    max_context_rows: int
    max_test_rows: int
    test_chunk_rows: int
    max_concurrent_calls: int
    max_columns: int
    max_cells: int
    max_levels: int
    max_execution_cells: int
    min_call_budget_s: float


class SupportedOutputsDTO(BaseModel):
    classification: list[Literal["labels", "probas"]]
    regression: list[Literal["mean", "median", "mode", "quantiles", "summary", "distribution"]]


class CapabilityExtensionDTO(BaseModel):
    name: Literal[
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
    ]
    status: Literal["supported", "unsupported", "unverified"] = "unsupported"
    provider_status: Literal["unverified", "synthetic"] = "unverified"


class FeatureCapabilityDTO(BaseModel):
    name: str
    status: Literal["supported", "unsupported", "unverified"]
    source: str
    verified_at: str
    parameters: list[str]
    constraints: list[str]
    evidence: str


class CapabilityCatalogueDTO(BaseModel):
    version: Literal[2]
    backend_key: Literal["fake", "priorlabs", "aicore"]
    model_key: str
    revision: str
    identity: str | None
    model_identity_kind: Literal["synthetic", "configured-mutable-alias"]
    limits: ConfiguredCapabilityLimitsDTO
    features: list[FeatureCapabilityDTO]
    live_verified: Literal[False]
    digest: str


class CapabilitiesDTO(BaseModel):
    catalogue_version: Literal[2] = 2
    backend: str
    identity: str | None
    prediction_contract_versions: list[Literal[2, 3]]
    verification: Literal["synthetic", "offline-adapter-tests"]
    live_verified: Literal[False] = False
    configured_limits: ConfiguredCapabilityLimitsDTO
    local_limits: LocalLimitsDTO
    outputs: SupportedOutputsDTO
    extensions: list[CapabilityExtensionDTO]
    catalogues: list[CapabilityCatalogueDTO]
    sdk_options: dict[str, str]
    sdk_utilities: dict[str, str]


class ErrorBody(BaseModel):
    code: str
    message: str
    retryable: bool


class ErrorDTO(BaseModel):
    error: ErrorBody

    @classmethod
    def of(cls, code: str, message: str, retryable: bool) -> dict[str, Any]:
        return cls(error=ErrorBody(code=code, message=message, retryable=retryable)).model_dump()
