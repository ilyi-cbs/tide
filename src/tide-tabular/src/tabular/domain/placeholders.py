from __future__ import annotations

import math
import statistics
from collections import Counter
from collections.abc import Callable
from typing import Any

from tabular.domain.models import (
    BackendOutput,
    ClassProbas,
    OutputSpec,
    Points,
    QuantileGrid,
    RegressionDistribution,
    RegressionSummary,
    Task,
    canonical_class_label,
)

MAJORITY_SCORE = 0.9


def _quantile(sorted_values: list[float], level: float) -> float:
    pos = level * (len(sorted_values) - 1)
    low, high = math.floor(pos), math.ceil(pos)
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (pos - low)


def context_prediction(
    task: Task, targets: list[Any], rows: int, output: OutputSpec
) -> BackendOutput:
    if task == "classification":
        classes = tuple(sorted({canonical_class_label(target) for target in targets}))
        counts = Counter(canonical_class_label(target) for target in targets)
        majority = max(classes, key=lambda label: (counts[label], label))
        rest_score = (1 - MAJORITY_SCORE) / (len(classes) - 1) if len(classes) > 1 else 0.0
        scores = tuple(MAJORITY_SCORE if label == majority else rest_score for label in classes)
        return ClassProbas(classes=classes, scores=tuple(scores for _ in range(rows)))
    values = sorted(float(target) for target in targets)
    quantiles = tuple(round(_quantile(values, level), 6) for level in output.levels)
    if output.type in ("summary", "distribution"):
        summary = RegressionSummary(
            means=tuple(statistics.fmean(values) for _ in range(rows)),
            medians=tuple(statistics.median(values) for _ in range(rows)),
            modes=tuple(statistics.mode(values) for _ in range(rows)),
            levels=output.levels,
            quantiles=tuple(quantiles for _ in range(rows)),
        )
        if output.type == "summary":
            return summary
        low, high = min(values), max(values)
        if low == high:
            low, high = low - 0.5, high + 0.5
        return RegressionDistribution(
            summary=summary,
            borders=(low, high),
            logits=tuple((0.0,) for _ in range(rows)),
            masked_logits=tuple((False,) for _ in range(rows)),
            tails="bounded_synthetic",
        )
    if output.type == "quantiles":
        return QuantileGrid(levels=output.levels, values=tuple(quantiles for _ in range(rows)))
    statistics_by_name: dict[str, Callable[[list[float]], float]] = {
        "mean": statistics.fmean,
        "median": statistics.median,
        "mode": statistics.mode,
    }
    point = round(statistics_by_name[output.statistic](values), 6)
    return Points(points=tuple(point for _ in range(rows)))
