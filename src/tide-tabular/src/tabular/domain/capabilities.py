from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Literal

from tabular.domain.models import Capabilities


@dataclass(frozen=True)
class FeatureCapability:
    name: str
    status: Literal["supported", "unsupported", "unverified"]
    source: str
    verified_at: str
    parameters: tuple[str, ...] = ()
    constraints: tuple[str, ...] = ()
    evidence: str = "offline"


@dataclass(frozen=True)
class CapabilityCatalogue:
    version: int
    backend_key: str
    model_key: str
    revision: str
    identity: str | None
    model_identity_kind: str
    limits: Capabilities
    features: tuple[FeatureCapability, ...]
    live_verified: bool = False

    @property
    def digest(self) -> str:
        return hashlib.sha256(
            json.dumps(asdict(self), sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()


def catalogue_for(
    backend: str, identity: str | None, limits: Capabilities, *, rich: bool, native: bool = False
) -> CapabilityCatalogue:
    source = (
        "tabpfn-client==0.6.0 public API"
        if backend == "priorlabs"
        else "configured SAP adapter wire fixtures; deployment manifest missing"
        if backend == "aicore"
        else "deterministic synthetic backend"
    )
    features = []
    for name in (
        "labels",
        "probas",
        "mean",
        "median",
        "mode",
        "quantiles",
        "summary",
        "distribution",
        "model_options",
        "thinking",
        "group_time",
        "fit_reuse",
        "kv_cache",
        "remote_jobs",
        "remote_cancel",
        "model_release",
    ):
        supported = name in ("labels", "probas", "mean", "quantiles")
        if name in ("median", "mode", "summary", "distribution"):
            supported = rich
        if name in ("model_options", "thinking", "group_time", "fit_reuse", "kv_cache"):
            supported = native and backend == "priorlabs"
        constraints: tuple[str, ...] = ()
        if name == "kv_cache":
            constraints = ("TabPFN-3+ only", "incompatible with managed thinking mode")
        if name == "group_time":
            constraints = (
                "thinking mode required",
                "named columns retained",
                "group and time are mutually exclusive",
                "grouped time requires group",
            )
        if name == "labels":
            constraints = ("SDK predict uses class-order argmax of predict_proba",)
        if name == "distribution":
            constraints = (
                "distinct chunk axes preserved",
                "masked -inf becomes null plus mask",
            )
        features.append(
            FeatureCapability(
                name=name,
                status="supported" if supported else "unsupported",
                source=source,
                verified_at="2026-10-04",
                constraints=constraints,
                evidence="synthetic" if backend == "fake" else "SDK/source and adapter fixtures",
                parameters=(
                    MODEL_OPTION_PARAMETERS
                    if name == "model_options" and backend == "priorlabs"
                    else ("thinking_mode", "thinking_effort", "fit_timeout", "thinking_metric")
                    if name == "thinking" and supported
                    else ("group_columns", "time_column", "grouped_time_column")
                    if name == "group_time" and supported
                    else ("fit_mode",)
                    if name in ("fit_reuse", "kv_cache") and supported
                    else ("levels",)
                    if name in ("quantiles", "summary", "distribution")
                    else ()
                ),
            )
        )
    return CapabilityCatalogue(
        version=2,
        backend_key=backend,
        model_key="default",
        revision="tabular-v3-sdk-0.6.0-r3",
        identity=identity,
        model_identity_kind="synthetic" if backend == "fake" else "configured-mutable-alias",
        limits=limits,
        features=tuple(features),
    )


MODEL_OPTION_PARAMETERS = (
    "n_estimators",
    "random_state",
    "softmax_temperature",
    "balance_probabilities",
    "average_before_softmax",
    "inference_precision",
    "inference_config",
    "ignore_pretraining_limits",
    "paper_version",
)

FIT_OPTION_PARAMETERS = (
    "thinking_mode",
    "thinking_effort",
    "fit_timeout",
    "thinking_metric",
    "fit_mode",
    "group_columns",
    "time_column",
    "grouped_time_column",
)


SDK_OPTION_INVENTORY = {
    "model_path": "configured modelKey binding; never an arbitrary caller path",
    "n_estimators": "modelOptions; server default remains unknown when omitted",
    "softmax_temperature": "modelOptions; positive finite",
    "balance_probabilities": "classification-only modelOptions",
    "average_before_softmax": "modelOptions",
    "ignore_pretraining_limits": "client validation bypass only; not a server-limit override",
    "inference_precision": "modelOptions; auto or autocast",
    "random_state": "modelOptions; constructor default 0",
    "inference_config": "typed SUBSAMPLE_SAMPLES; other keys unverified and rejected",
    "categorical_features_indices": "derived from effective named column schema",
    "fit_mode": "fitOptions; fit_preprocessors or fit_with_cache",
    "paper_version": "modelOptions",
    "thinking_mode": "fitOptions",
    "thinking_effort": "fitOptions; medium or high",
    "thinking_timeout_s": "fitOptions.fit_timeout",
    "thinking_metric": "fitOptions.thinking_metric; provider validates accepted metric",
    "group_col": "fitOptions.group_columns",
    "time_col": "fitOptions.time_column",
    "group_time_col": "fitOptions.grouped_time_column",
    "api_mode": "transport-only SDK AUTO; not a public job-control capability",
    "client_options": "transport-only adapter deadline; caller headers forbidden",
}


SDK_UTILITY_INVENTORY = {
    "fit": "model behavior; native reusable fit",
    "predict": "model behavior; labels or regression output",
    "predict_proba": "model behavior; classification probabilities",
    "save_model": "reference export; JSON without transport credentials",
    "load_model": "reference import; signed application references only",
    "get_params": "diagnostic; omitted server defaults remain unknown",
    "set_params": "configuration utility; request schemas replace mutation",
    "get_timings": "diagnostic; provider timing when present",
    "score": "evaluation utility; not a prediction operation",
    "get_metadata_routing": "scikit-learn utility",
    "set_fit_request": "scikit-learn utility",
    "set_predict_request": "scikit-learn utility",
    "set_score_request": "scikit-learn utility",
    "init": "authentication utility",
    "set_access_token": "authentication; one binding per process",
    "get_access_token": "authentication; never exposed in API",
    "interactive_login": "interactive authentication; not a service operation",
    "reset": "authentication administration; not exposed",
    "UserDataClient": "dataset administration; never used as cancellation",
    "get_api_usage": "account administration; not billing reconciliation",
    "estimate_cost": "cost estimation utility; not budget enforcement",
    "prompt_agent": "interactive utility; outside numerical runtime",
    "ServiceClient.get_settings": "provider metadata; row/column/output-specific limits",
}
