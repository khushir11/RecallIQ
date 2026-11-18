"""
Train the RecallIQ runtime model on YOUR OWN historical data (same six features the app uses).

CSV columns (header names must match):
  days_since_last_order, order_count, total_spent, engagement_score, support_tickets, cart_value, churned

`churned` must be a real observed outcome (1 = did not purchase again within your chosen window,
e.g. 90 days after the snapshot date; 0 = purchased again). Features must be measured at the
snapshot date, BEFORE the outcome window, or the evaluation will be misleadingly optimistic.

Run:
  python train_behavioral.py --data data/my_customers.csv

Outputs model_artifacts/behavioral_model.joblib + behavioral_model.json. Restart the service and
/health will report provenance "user-trained" with these hold-out metrics.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from app import FEATURES

OUT = Path(__file__).resolve().parent / "model_artifacts"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--min-rows", type=int, default=500)
    args = ap.parse_args()

    df = pd.read_csv(args.data)
    missing = [c for c in FEATURES + ["churned"] if c not in df.columns]
    if missing:
        raise SystemExit(f"Missing columns: {missing}")
    df = df[FEATURES + ["churned"]].dropna()
    if len(df) < args.min_rows:
        raise SystemExit(f"Only {len(df)} usable rows; need at least {args.min_rows} for a meaningful evaluation.")
    y = df["churned"].astype(int)
    if y.nunique() != 2:
        raise SystemExit("`churned` must contain both 0 and 1.")

    X_train, X_test, y_train, y_test = train_test_split(df[FEATURES].values, y.values, test_size=0.2, stratify=y, random_state=42)
    model = Pipeline([("scale", StandardScaler()), ("classifier", LogisticRegression(max_iter=2000, class_weight="balanced", random_state=42))])
    model.fit(X_train, y_train)
    prob = model.predict_proba(X_test)[:, 1]
    pred = (prob >= 0.5).astype(int)
    metrics = {
        "rows": int(len(df)), "test_rows": int(len(X_test)), "positive_rate": round(float(y.mean()), 3),
        "roc_auc": round(float(roc_auc_score(y_test, prob)), 3), "accuracy": round(float(accuracy_score(y_test, pred)), 3),
        "precision": round(float(precision_score(y_test, pred, zero_division=0)), 3),
        "recall": round(float(recall_score(y_test, pred, zero_division=0)), 3), "f1": round(float(f1_score(y_test, pred, zero_division=0)), 3),
    }
    OUT.mkdir(exist_ok=True)
    joblib.dump(model, OUT / "behavioral_model.joblib")
    meta = {
        "provenance": "user-trained",
        "description": f"Logistic regression trained on {Path(args.data).name} ({len(df)} rows).",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "metrics": metrics,
        "metrics_note": "Stratified 80/20 hold-out on the supplied dataset.",
    }
    (OUT / "behavioral_model.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
