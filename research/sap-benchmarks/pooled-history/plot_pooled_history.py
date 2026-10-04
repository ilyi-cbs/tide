# Copyright 2026 cbs Corporate Business Solutions GmbH
# SPDX-License-Identifier: Apache-2.0

"""Draw the full-context figures from the revision tables in this folder.

uv run --project research --frozen python research/sap-benchmarks/pooled-history/plot_pooled_history.py
"""

from __future__ import annotations

import csv
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = Path(__file__).resolve().parent
CURVES = (
    HERE / "confidence-accuracy-coverage-points.csv"
)  # aggregate points: target, model, coverage, accuracy


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def pick(rows: list[dict[str, str]], **want: str) -> dict[str, str]:
    for row in rows:
        if all((row.get(key) or "") == value for key, value in want.items()):
            return row
    raise KeyError(want)


def risk_figure() -> None:
    if not CURVES.exists():
        print(f"{CURVES.name} not found, keeping the committed confidence-accuracy-coverage-curves.png")
        return
    curves = read_csv(CURVES)
    fig, axes = plt.subplots(1, 2, figsize=(9.4, 4.3), sharey=True)
    panels = (
        ("account_assignment", "Account assignment"),
        ("material_group", "Material group"),
    )
    for ax, (target, title) in zip(axes, panels, strict=True):
        for model, color, label in (
            ("tabpfn", "C0", "TabPFN"),
            ("lightgbm_tuned", "C1", "Tuned LightGBM"),
        ):
            pts = [
                row
                for row in curves
                if row["target"] == target and row["model"] == model
            ]
            coverage = np.array([float(row["coverage"]) for row in pts])
            accuracy = np.array([float(row["accuracy"]) for row in pts])
            ax.plot(coverage, accuracy, color=color, label=label, linewidth=1.5)
            for level in (0.90, 0.95):
                ok = np.flatnonzero(accuracy >= level)
                if len(ok):
                    index = ok[-1]
                    ax.scatter(
                        [coverage[index]],
                        [accuracy[index]],
                        s=22,
                        color=color,
                        zorder=4,
                    )
        ax.axhline(0.90, color="0.45", linewidth=0.7, linestyle="--")
        ax.axhline(0.95, color="0.45", linewidth=0.7, linestyle=":")
        ax.set_xlim(0, 1)
        ax.set_ylim(0.6, 1.0)
        ax.set_xlabel("coverage")
        ax.set_title(title, fontsize=11)
        ax.tick_params(labelsize=9)
        ax.legend(frameon=False, loc="lower left", fontsize=9)
    axes[0].set_ylabel("accuracy of accepted rows")
    fig.tight_layout()
    fig.savefig(HERE / "confidence-accuracy-coverage-curves.png", dpi=120)
    plt.close(fig)


def _interval(row: dict[str, str]) -> tuple[float, float, float]:
    effect = float(row["value"])
    return effect, float(row["ci_low"]), float(row["ci_high"])


def forest_figure() -> None:
    published = read_csv(HERE / "published-model-results.csv")
    reproduced = read_csv(HERE / "reproduced-baseline-results.csv")
    coverage = read_csv(HERE / "equal-accuracy-coverage-results.csv")
    robust = read_csv(HERE / "temporal-robustness-results.csv")
    left_rows = [
        (
            "Account assignment accuracy",
            _interval(
                pick(
                    published,
                    target="account_assignment",
                    model="tabpfn_minus_tuned",
                    metric="accuracy",
                )
            ),
        ),
        (
            "Material group accuracy",
            _interval(
                pick(reproduced, target="material_group", metric="accuracy_effect")
            ),
        ),
        (
            "Account assignment, coverage 0.90",
            _interval(
                pick(coverage, target="account_assignment", metric="coverage_diff_0.90")
            ),
        ),
        (
            "Account assignment, coverage 0.95",
            _interval(
                pick(coverage, target="account_assignment", metric="coverage_diff_0.95")
            ),
        ),
        (
            "Material group, coverage 0.90",
            _interval(
                pick(coverage, target="material_group", metric="coverage_diff_0.90")
            ),
        ),
        (
            "Material group, coverage 0.95",
            _interval(
                pick(coverage, target="material_group", metric="coverage_diff_0.95")
            ),
        ),
    ]
    main = pick(
        reproduced,
        target="lead_time",
        metric="mae",
        note="clustered by material supplier plant, positive means tabpfn better",
    )
    right_rows = [("Main run", _interval(main))]
    for cutoff in ("2025-09-04", "2025-07-10", "2025-05-15"):
        right_rows.append(
            (
                cutoff,
                _interval(
                    pick(
                        robust, cutoff=cutoff, model="tabpfn_minus_tuned", metric="mae"
                    )
                ),
            )
        )
    fig, axes = plt.subplots(1, 2, figsize=(11.2, 4.6))
    _panel(axes[0], left_rows, "Free-text codes", "difference in share")
    _panel(axes[1], right_rows, "Lead time", "days")
    fig.tight_layout()
    fig.savefig(HERE / "model-comparison-effects.png", dpi=120)
    plt.close(fig)


def _panel(
    ax, rows: list[tuple[str, tuple[float, float, float]]], title: str, xlabel: str
) -> None:
    rows = list(reversed(rows))
    ys = np.arange(len(rows))
    effects = np.array([row[1][0] for row in rows])
    lo = effects - np.array([row[1][1] for row in rows])
    hi = np.array([row[1][2] for row in rows]) - effects
    ax.errorbar(
        effects,
        ys,
        xerr=[lo, hi],
        fmt="o",
        color="C0",
        markersize=5,
        capsize=3,
        linewidth=1,
    )
    ax.axvline(0, color="0.45", linewidth=0.8)
    span = max(float(np.max(effects + hi)), float(np.max(np.abs(effects - lo))), 0.02)
    ax.set_xlim(-span * 1.15, span * 1.15)
    ax.set_yticks(ys, [row[0] for row in rows], fontsize=9)
    ax.set_title(title, fontsize=11)
    ax.set_xlabel(f"{xlabel}. Right means TabPFN better.", fontsize=9)
    ax.tick_params(axis="x", labelsize=9)
    for y, (effect, low, high) in zip(ys, (row[1] for row in rows)):
        ax.text(
            1.02,
            y,
            f"{effect:.3f} [{low:.3f}, {high:.3f}]",
            transform=ax.get_yaxis_transform(),
            va="center",
            ha="left",
            fontsize=8,
            clip_on=False,
        )


if __name__ == "__main__":
    risk_figure()
    forest_figure()
