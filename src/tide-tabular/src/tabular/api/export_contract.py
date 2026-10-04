from __future__ import annotations

import json
import time
from pathlib import Path

from tabular.api.main import app
from tabular.api.schemas import PredictRequestV3DTO, TabularResultV3DTO
from tabular.application.predict import Limits, PredictService
from tabular.infrastructure.backends.fake import FakeBackend


def main() -> None:
    fixtures = Path(__file__).resolve().parents[3] / "tests" / "fixtures"
    snapshot = fixtures / "tabular.openapi.json"
    schema = app.openapi()
    previous = json.loads(snapshot.read_text())
    for route in ("/health", "/v1/tabular"):
        if previous["paths"][route] != schema["paths"][route]:
            raise RuntimeError(f"existing v2 route changed: {route}")
    for name in (
        "ColumnDTO",
        "OutputDTO",
        "PredictRequestDTO",
        "PredictionDTO",
        "UsageDTO",
        "TabularResultDTO",
        "HealthDTO",
    ):
        if previous["components"]["schemas"][name] != schema["components"]["schemas"][name]:
            raise RuntimeError(f"existing v2 schema changed: {name}")
    snapshot.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n")
    service = PredictService(
        FakeBackend(),
        Limits(
            max_context_rows=1000, max_test_rows=1000, test_chunk_rows=1000, max_concurrent_calls=1
        ),
        cache_identity="synthetic-contract-v3",
    )
    examples = fixtures / "examples"
    versioned = examples / "v3"
    versioned.mkdir(exist_ok=True)
    try:
        variants = [
            ("labels", "probas", {"type": "labels"}),
            ("probas", "probas", {"type": "probas"}),
            ("mean", "point", {"type": "point", "statistic": "mean"}),
            ("median", "point", {"type": "point", "statistic": "median"}),
            ("mode", "point", {"type": "point", "statistic": "mode"}),
            ("quantiles", "quantiles", {"type": "quantiles", "levels": [0.1, 0.9]}),
            ("summary", "quantiles", {"type": "summary", "levels": [0.1, 0.9]}),
            ("distribution", "quantiles", {"type": "distribution", "levels": [0.1, 0.9]}),
        ]
        for name, template, output in variants:
            body = json.loads((examples / f"{template}.request.json").read_text())
            body.update(backendKey="fake", modelKey="default", output=output)
            request = PredictRequestV3DTO.model_validate(body).to_domain()
            result = service.run_v3(request, deadline=time.monotonic() + 30)
            response = TabularResultV3DTO.of(
                request,
                result,
                service.backend_identity,
                service.capability_digest,
                service.plan_fingerprint(request),
            ).model_dump()
            response["elapsed_ms"] = 0.0
            for direction, content in (("request", body), ("response", response)):
                (versioned / f"{name}.{direction}.json").write_text(
                    json.dumps(content, indent=2, sort_keys=True, allow_nan=False) + "\n"
                )
    finally:
        service.close()
    print("OpenAPI and eight synthetic v3 exchanges exported; existing v2 schemas preserved")


if __name__ == "__main__":
    main()
