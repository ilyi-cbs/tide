# Copyright 2026 cbs Corporate Business Solutions GmbH
# SPDX-License-Identifier: Apache-2.0

"""Draw the figures of sap-benchmark-report.md from sap-benchmark-results.csv in this folder.

matplotlib is not a product dependency; run with
    uv run --project research --frozen python research/sap-benchmarks/plot_sap_benchmarks.py
"""

from __future__ import annotations

import csv
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = Path(__file__).resolve().parent

FAMILIES = (
    ("lead_time", "Lead time"),
    ("material_master", "Material master fields"),
    ("material_text", "Material master with text"),
    ("free_text", "Free-text codes"),
    ("calibration", "Calibration"),
    ("label_noise", "Label noise"),
    ("error_detection", "Error detection"),
    ("rollout", "Plant not in the context"),
)
TASKS = {
    "lead_time": "All suppliers",
    "lead_time_without_largest_supplier": "Without the largest supplier",
    "lead_time_no_material_supplier": "No material or supplier columns",
    "lot_sizing": "Lot sizing",
    "purchasing_group": "Purchasing group",
    "valuation_class": "Valuation class",
    "profit_center": "Profit center",
    "mrp_controller": "MRP controller",
    "material_group": "Material group",
    "supplier": "Supplier",
    "account_assignment": "Account assignment",
    "decision_fields": "No text",
    "decision_fields_text": "With text",
    "decision_fields_no_text": "No text, full size",
    "rollout": "Held-out plants",
}
CONTEXT_LABEL = {
    "full": "full",
    "held_out": "held out",
    "0.1": "10% noise",
    "0.2": "20% noise",
    "0.3": "30% noise",
}


def rows() -> list[dict[str, str]]:
    with (HERE / "sap-benchmark-results.csv").open(encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def context_key(value: str) -> tuple[int, float, str]:
    try:
        return (0, float(value), value)
    except ValueError:
        rank = {"full": 1, "held_out": 2}.get(value, 3)
        return (1, float(rank), value)


def context_label(value: str) -> str:
    return CONTEXT_LABEL.get(value, value)


def main_figure(data: list[dict[str, str]]) -> None:
    plotted = [r for r in data if r["plot"] == "1"]
    fig, axes = plt.subplots(2, 4, figsize=(14.5, 9.6))
    for ax, (family, title) in zip(axes.ravel(), FAMILIES, strict=True):
        sub = [r for r in plotted if r["family"] == family]
        contexts = sorted({r["context"] for r in sub}, key=context_key)
        tasks = []
        for row in sub:
            if row["task"] not in tasks:
                tasks.append(row["task"])
        reliable = [
            r
            for r in sub
            if r["verdict"] != "baseline_unreliable" and r["interval_ok"] == "1"
        ]
        if reliable:
            lo = min(float(r["ci_low"]) for r in reliable)
            hi = max(float(r["ci_high"]) for r in reliable)
            pad = 0.12 * max(hi - lo, 0.02)
            xmin, xmax = lo - pad, hi + pad
        else:
            xmin, xmax = -0.05, 0.05
        xmin = min(xmin, -0.01)
        xmax = max(xmax, 0.01)
        ax.set_xlim(xmin, xmax)
        ax.axvline(0, color="0.45", linewidth=0.8)
        width = 0.72 / max(len(tasks), 1)
        for index, task in enumerate(tasks):
            color = f"C{index % 8}"
            for row in (r for r in sub if r["task"] == task):
                y = (
                    contexts.index(row["context"])
                    + (index - (len(tasks) - 1) / 2) * width
                )
                effect = float(row["effect"])
                shown = min(
                    max(effect, xmin + 0.01 * (xmax - xmin)),
                    xmax - 0.01 * (xmax - xmin),
                )
                off = effect < xmin or effect > xmax
                if row["verdict"] == "baseline_unreliable" or row["interval_ok"] == "0":
                    ax.scatter([shown], [y], marker="x", color="0.15", s=36, zorder=4)
                    if off:
                        ax.annotate(
                            f"{effect:.2f}",
                            (shown, y),
                            textcoords="offset points",
                            xytext=(4, 0),
                            fontsize=7,
                            va="center",
                        )
                    continue
                if off:
                    ax.scatter(
                        [shown],
                        [y],
                        marker=">" if effect > xmax else "<",
                        color=color,
                        s=28,
                        zorder=4,
                    )
                    ax.annotate(
                        f"{effect:.2f}",
                        (shown, y),
                        textcoords="offset points",
                        xytext=(4 if effect > xmax else -4, 0),
                        fontsize=7,
                        va="center",
                        ha="left" if effect > xmax else "right",
                    )
                    continue
                err_lo = effect - float(row["ci_low"])
                err_hi = float(row["ci_high"]) - effect
                neutral = row["verdict"] == "equal"
                ax.errorbar(
                    [effect],
                    [y],
                    xerr=[[err_lo], [err_hi]],
                    fmt="o",
                    color="0.55" if neutral else color,
                    markersize=3.2,
                    capsize=2,
                    linewidth=0.7,
                )
        handles = []
        labels = []
        for index, task in enumerate(tasks):
            handles.append(
                plt.Line2D([0], [0], marker="o", color=f"C{index % 8}", linestyle="")
            )
            labels.append(TASKS.get(task, task))
        ax.legend(
            handles,
            labels,
            fontsize=8,
            loc="upper center",
            bbox_to_anchor=(0.5, -0.28),
            ncol=2,
            frameon=False,
        )
        ax.set_yticks(
            range(len(contexts)), [context_label(c) for c in contexts], fontsize=7
        )
        ax.set_title(title, fontsize=9)
        ax.tick_params(axis="x", labelsize=7)
    for ax in axes[:, 0]:
        ax.set_ylabel("context rows")
    fig.supxlabel(
        "For a lower-is-better metric, effect = comparison minus TabPFN. Otherwise effect = TabPFN minus comparison. Right means TabPFN better."
    )
    fig.suptitle(
        "Where TabPFN wins. Grey intervals cross zero. Crosses are baseline-unreliable cells."
    )
    fig.tight_layout(rect=(0, 0.03, 1, 0.96))
    fig.subplots_adjust(hspace=0.72)
    fig.savefig(HERE / "benchmark-effect-overview.png", dpi=120)


def learning_curve(
    data: list[dict[str, str]],
    *,
    family: str,
    task: str,
    metric: str,
    title: str,
    ylabel: str,
    name: str,
    section: str | None = None,
) -> None:
    fig, ax = plt.subplots(figsize=(6.2, 3.6))
    series = []
    for row in data:
        if section is not None and row["section"] != section:
            continue
        if (
            row["family"] == family
            and row["task"] == task
            and row["metric"] == metric
            and row["verdict"] != "baseline_unreliable"
        ):
            series.append(row)
    series.sort(key=lambda row: context_key(row["context"]))
    xs = list(range(len(series)))
    ys = [float(row["effect"]) for row in series]
    lo = [ys[i] - float(series[i]["ci_low"]) for i in range(len(series))]
    hi = [float(series[i]["ci_high"]) - ys[i] for i in range(len(series))]
    colors = ["0.55" if row["verdict"] == "equal" else "C0" for row in series]
    ax.errorbar(xs, ys, yerr=[lo, hi], fmt="none", ecolor="0.6", capsize=3)
    ax.scatter(xs, ys, c=colors, s=28, zorder=3)
    ax.plot(xs, ys, color="C0", linewidth=0.8)
    ax.axhline(0, color="0.45", linewidth=0.8)
    ax.set_xticks(xs, [context_label(row["context"]) for row in series])
    ax.set_xlabel("context rows")
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    fig.tight_layout()
    fig.savefig(HERE / name, dpi=120)


def main() -> None:
    data = rows()
    main_figure(data)
    learning_curve(
        data,
        family="lead_time",
        task="lead_time",
        metric="mae",
        title="Lead time, all suppliers: MAE effect over context size",
        ylabel="MAE effect (days), up means TabPFN better",
        name="lead-time-context-size-effects.png",
        section="5.2",
    )
    learning_curve(
        data,
        family="material_text",
        task="profit_center",
        metric="accuracy",
        title="Profit center with the description: accuracy effect",
        ylabel="accuracy effect, up means TabPFN better",
        name="profit-center-text-context-size-effects.png",
        section="5.5",
    )


if __name__ == "__main__":
    main()
