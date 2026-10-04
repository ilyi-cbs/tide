# Copyright 2026 cbs Corporate Business Solutions GmbH
# SPDX-License-Identifier: Apache-2.0

"""Draw the figures of replication-report.md from the CSV tables next to it.

matplotlib is not a product dependency; run with
    uv run --project research --frozen python research/usaspending/plot_usaspending.py
"""

from __future__ import annotations

import csv
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = Path(__file__).resolve().parent
TASKS = {
    "product_or_service_code": "Product or service code",
    "awarding_office": "Awarding office",
    "recipient": "Recipient",
}
ACCURACY_ARMS = {
    "tabpfn_text": "TabPFN with text",
    "tabpfn_notext": "TabPFN without text",
    "logreg_tfidf": "Logistic regression (TF-IDF)",
    "knn_cv": "kNN (TF-IDF)",
}
RECALL_ARMS = {
    "tabpfn_text": "TabPFN with text",
    "knn_1": "Most similar item",
    "knn_cv": "kNN (TF-IDF)",
    "logreg_tfidf": "Logistic regression (TF-IDF)",
}


def rows(name: str) -> list[dict[str, str]]:
    with (HERE / name).open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def accuracy_figure() -> None:
    data = rows("context-size-accuracy.csv")
    fig, axes = plt.subplots(1, 3, figsize=(12, 3.8), sharey=False)
    for ax, (task, title) in zip(axes, TASKS.items(), strict=True):
        sub = [r for r in data if r["task"] == task]
        sizes = [r["context_rows"] for r in sub]
        for arm, label in ACCURACY_ARMS.items():
            ax.plot(sizes, [float(r[arm]) for r in sub], marker="o", label=label)
        ax.set_title(title)
        ax.set_xlabel("context rows per segment")
        ax.set_ylim(bottom=0)
    axes[0].set_ylabel("accuracy")
    axes[0].legend(fontsize=8)
    fig.suptitle(
        "USAspending contract awards: accuracy by context size (test window Apr to Sep 2024)"
    )
    fig.tight_layout()
    fig.savefig(HERE / "context-size-accuracy.png", dpi=120)


def difference_figure() -> None:
    data = rows("best-baseline-accuracy-effects.csv")
    sizes = ["250", "1000", "full"]
    width = 0.25
    fig, ax = plt.subplots(figsize=(8, 3.8))
    for i, (task, title) in enumerate(TASKS.items()):
        sub = {r["context_rows"]: r for r in data if r["task"] == task}
        d = [float(sub[s]["accuracy_difference"]) for s in sizes]
        lo = [d[j] - float(sub[s]["ci_low"]) for j, s in enumerate(sizes)]
        hi = [float(sub[s]["ci_high"]) - d[j] for j, s in enumerate(sizes)]
        x = [j + (i - 1) * width for j in range(len(sizes))]
        ax.errorbar(x, d, yerr=[lo, hi], fmt="o", capsize=4, label=title)
    ax.axhline(0, color="grey", linewidth=0.8)
    ax.set_xticks(range(len(sizes)), sizes)
    ax.set_xlabel("context rows per segment")
    ax.set_ylabel("accuracy difference")
    ax.legend(fontsize=8)
    ax.set_title("TabPFN with text minus the best baseline, paired, 95% interval")
    fig.tight_layout()
    fig.savefig(HERE / "best-baseline-accuracy-effects.png", dpi=120)


def recall_figure() -> None:
    data = rows("new-code-adaptation-recall.csv")
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.8))
    for ax, task in zip(axes, ("product_or_service_code", "recipient"), strict=True):
        sub = [r for r in data if r["task"] == task]
        for arm, label in RECALL_ARMS.items():
            pts = [(int(r["examples"]), float(r[arm])) for r in sub if r[arm]]
            ax.plot([k for k, _ in pts], [v for _, v in pts], marker="o", label=label)
        ax.set_title(TASKS[task])
        ax.set_xticks([0, 1, 2, 4])
        ax.set_xlabel("confirmed examples of the new code")
        ax.set_ylim(0, 1)
    axes[0].set_ylabel("recall on the new code")
    axes[0].legend(fontsize=8)
    fig.suptitle("New codes from a few confirmed examples")
    fig.tight_layout()
    fig.savefig(HERE / "new-code-adaptation-recall.png", dpi=120)


if __name__ == "__main__":
    accuracy_figure()
    difference_figure()
    recall_figure()
