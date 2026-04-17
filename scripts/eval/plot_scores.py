"""
Visualize embedding score distributions: relevant vs irrelevant emails.

Usage:
  python scripts/eval/plot_scores.py data/mock-mailbox-large-embedding-scores.json
  python scripts/eval/plot_scores.py data/mock-mailbox-large-embedding-scores.json --per-event
"""

import json
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np


def load_scores(path: str) -> list[dict]:
    with open(path) as f:
        return json.load(f)


def plot_aggregate(data: list[dict], out_dir: Path):
    """Single figure: overlaid histograms of relevant vs irrelevant scores across all events."""
    events_with_gt = [e for e in data if e["expectedProjectId"]]

    relevant = []
    irrelevant = []
    for event in events_with_gt:
        for s in event["scores"]:
            if s["isRelevant"]:
                relevant.append(s["score"])
            else:
                irrelevant.append(s["score"])

    if not relevant:
        print("No relevant scores found (no events with ground truth?)")
        return

    fig, ax = plt.subplots(figsize=(12, 6))

    bins = np.linspace(
        min(min(relevant), min(irrelevant)),
        max(max(relevant), max(irrelevant)),
        80,
    )

    ax.hist(irrelevant, bins=bins, alpha=0.6, label=f"Irrelevant (n={len(irrelevant)})", color="#e74c3c", density=True)
    ax.hist(relevant, bins=bins, alpha=0.6, label=f"Relevant (n={len(relevant)})", color="#2ecc71", density=True)

    # Add medians
    med_rel = np.median(relevant)
    med_irr = np.median(irrelevant)
    ax.axvline(med_rel, color="#27ae60", linestyle="--", linewidth=2, label=f"Median relevant: {med_rel:.4f}")
    ax.axvline(med_irr, color="#c0392b", linestyle="--", linewidth=2, label=f"Median irrelevant: {med_irr:.4f}")

    ax.set_xlabel("Cosine Similarity Score", fontsize=13)
    ax.set_ylabel("Density", fontsize=13)
    ax.set_title(
        f"Embedding Score Distribution — Relevant vs Irrelevant Emails\n"
        f"({len(events_with_gt)} events, {len(relevant)} relevant / {len(irrelevant)} irrelevant emails)",
        fontsize=14,
    )
    ax.legend(fontsize=11)
    ax.grid(True, alpha=0.3)

    out_path = out_dir / "score_distribution_aggregate.png"
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    print(f"Saved: {out_path}")
    plt.close(fig)


def plot_per_event(data: list[dict], out_dir: Path):
    """One subplot per event showing the score separation."""
    events_with_gt = [e for e in data if e["expectedProjectId"]]
    if not events_with_gt:
        print("No events with ground truth.")
        return

    n = len(events_with_gt)
    cols = min(3, n)
    rows = (n + cols - 1) // cols

    fig, axes = plt.subplots(rows, cols, figsize=(6 * cols, 4 * rows), squeeze=False)

    for idx, event in enumerate(events_with_gt):
        ax = axes[idx // cols][idx % cols]

        rel = [s["score"] for s in event["scores"] if s["isRelevant"]]
        irr = [s["score"] for s in event["scores"] if not s["isRelevant"]]

        if not rel and not irr:
            ax.set_title(event["meetingSubject"][:40], fontsize=9)
            continue

        all_scores = rel + irr
        bins = np.linspace(min(all_scores), max(all_scores), 40)

        if irr:
            ax.hist(irr, bins=bins, alpha=0.6, color="#e74c3c", density=True, label=f"Irr ({len(irr)})")
        if rel:
            ax.hist(rel, bins=bins, alpha=0.6, color="#2ecc71", density=True, label=f"Rel ({len(rel)})")

        ax.set_title(event["meetingSubject"][:50], fontsize=9)
        ax.legend(fontsize=7)
        ax.grid(True, alpha=0.3)

    # Hide empty subplots
    for idx in range(n, rows * cols):
        axes[idx // cols][idx % cols].set_visible(False)

    fig.suptitle("Per-Event Embedding Score Distributions", fontsize=14, y=1.01)
    fig.tight_layout()
    out_path = out_dir / "score_distribution_per_event.png"
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    print(f"Saved: {out_path}")
    plt.close(fig)


def main():
    if len(sys.argv) < 2:
        print("Usage: python plot_scores.py <scores.json> [--per-event]")
        sys.exit(1)

    scores_path = sys.argv[1]
    per_event = "--per-event" in sys.argv

    data = load_scores(scores_path)
    out_dir = Path(scores_path).parent

    print(f"Loaded {len(data)} events from {scores_path}")

    plot_aggregate(data, out_dir)
    if per_event:
        plot_per_event(data, out_dir)
    else:
        print("Add --per-event for individual event plots")


if __name__ == "__main__":
    main()
