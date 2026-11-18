"""
RecallIQ ML risk service (FastAPI).

MODEL PROVENANCE — read before quoting any number:
  * By default the service trains a logistic-regression model at startup on SYNTHETIC data.
    The churn labels are produced by a hand-written rule (see `synthetic_dataset`), so the model
    is learning that rule back. Its hold-out metrics only show how well it recovers the rule;
    they say nothing about real-world churn accuracy.
  * If `model_artifacts/behavioral_model.joblib` exists (created by `train_behavioral.py` from a
    CSV of your own historical customers with a real churn label), that model is used instead
    and /health reports its provenance and metrics.

Endpoints:
  GET  /health          – status, model provenance, metrics
  POST /predict         – one customer
  POST /predict/batch   – up to 1000 customers
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import List

import joblib
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel, Field
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

BASE = Path(__file__).resolve().parent
ARTIFACT = BASE / "model_artifacts" / "behavioral_model.joblib"
ARTIFACT_META = BASE / "model_artifacts" / "behavioral_model.json"

FEATURES = [
    "days_since_last_order",
    "order_count",
    "total_spent",
    "engagement_score",
    "support_tickets",
    "cart_value",
]
LABELS = {
    "days_since_last_order": "Days since last order",
    "order_count": "Number of orders",
    "total_spent": "Lifetime spend",
    "engagement_score": "Engagement score",
    "support_tickets": "Support tickets",
    "cart_value": "Open cart value",
}
# Synthetic training range per feature (used to flag out-of-range inputs).
RANGES = {
    "days_since_last_order": (0, 365),
    "order_count": (0, 40),
    "total_spent": (0, 300000),
    "engagement_score": (0, 100),
    "support_tickets": (0, 10),
    "cart_value": (0, 25000),
}
HIGH, MEDIUM = 0.70, 0.40

app = FastAPI(title="RecallIQ ML Service", version="3.0.0")


class CustomerFeatures(BaseModel):
    days_since_last_order: float = Field(ge=0, le=3650, description="Days since the last order")
    order_count: float = Field(ge=0, le=100000)
    total_spent: float = Field(ge=0, le=1e9, description="Lifetime spend in INR")
    engagement_score: float = Field(ge=0, le=100)
    support_tickets: float = Field(ge=0, le=10000)
    cart_value: float = Field(ge=0, le=1e8, description="Current cart value in INR")


class BatchRequest(BaseModel):
    customers: List[CustomerFeatures] = Field(min_length=1, max_length=1000)


def synthetic_dataset(n: int = 6000, seed: int = 42):
    """Synthetic customers on an Indian-retail rupee scale with labels from a known rule."""
    rng = np.random.default_rng(seed)
    days = np.clip(rng.gamma(1.6, 45, n), 0, 365)
    orders = np.clip(rng.poisson(6, n) + rng.integers(0, 4, n), 0, 40)
    aov = np.clip(rng.lognormal(7.4, 0.5, n), 200, 15000)  # ≈ ₹1,600 median order
    spend = np.clip(orders * aov, 0, 300000)
    engagement = np.clip(rng.normal(55, 22, n), 0, 100)
    tickets = np.clip(rng.poisson(1.2, n), 0, 10)
    cart = np.where(rng.random(n) < 0.35, np.clip(rng.gamma(1.6, 1500, n), 0, 25000), 0)

    # The "true" rule the model will try to learn (this IS the synthetic assumption):
    logit = (
        0.030 * (days - 45)
        - 0.12 * (orders - 6)
        - 0.000004 * (spend - 10000)
        - 0.035 * (engagement - 55)
        + 0.30 * tickets
        - 0.00008 * cart
        - 0.6
    )
    p = 1 / (1 + np.exp(-logit))
    y = (rng.random(n) < p).astype(int)
    X = np.column_stack([days, orders, spend, engagement, tickets, cart])
    return X, y


def train_synthetic():
    X, y = synthetic_dataset()
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.25, stratify=y, random_state=42)
    model = Pipeline([("scale", StandardScaler()), ("classifier", LogisticRegression(max_iter=2000, random_state=42))])
    model.fit(X_train, y_train)
    prob = model.predict_proba(X_test)[:, 1]
    pred = (prob >= 0.5).astype(int)
    metrics = {
        "rows": int(len(X)),
        "test_rows": int(len(X_test)),
        "positive_rate": round(float(y.mean()), 3),
        "roc_auc": round(float(roc_auc_score(y_test, prob)), 3),
        "accuracy": round(float(accuracy_score(y_test, pred)), 3),
        "precision": round(float(precision_score(y_test, pred, zero_division=0)), 3),
        "recall": round(float(recall_score(y_test, pred, zero_division=0)), 3),
        "f1": round(float(f1_score(y_test, pred, zero_division=0)), 3),
    }
    meta = {
        "provenance": "synthetic",
        "description": "Logistic regression trained at startup on 6,000 synthetic customers whose churn labels come from a hand-written rule. Demonstration only — not validated on real customers.",
        "metrics": metrics,
        "metrics_note": "Hold-out metrics on synthetic data: they measure how well the model recovers the synthetic rule, not real-world churn accuracy.",
    }
    return model, meta


def load_model():
    if ARTIFACT.exists():
        model = joblib.load(ARTIFACT)
        meta = json.loads(ARTIFACT_META.read_text()) if ARTIFACT_META.exists() else {}
        meta.setdefault("provenance", "user-trained")
        meta.setdefault("description", "Model trained with train_behavioral.py on a user-supplied dataset.")
        return model, meta
    return train_synthetic()


MODEL, MODEL_META = load_model()


def contributions(x: np.ndarray):
    """Per-feature contribution to the log-odds (coefficient × standardised value)."""
    scaler = MODEL.named_steps.get("scale")
    clf = MODEL.named_steps.get("classifier")
    if scaler is None or clf is None or not hasattr(clf, "coef_"):
        return None
    z = (x - scaler.mean_) / scaler.scale_
    return clf.coef_[0] * z


def explain(f: CustomerFeatures, contrib):
    values = {name: getattr(f, name) for name in FEATURES}
    drivers, protective = [], []
    if contrib is not None:
        order = np.argsort(-np.abs(contrib))
        for idx in order:
            c = float(contrib[idx])
            if abs(c) < 0.15:
                continue
            name = FEATURES[idx]
            item = {"feature": name, "label": LABELS[name], "value": values[name], "impact": round(c, 3)}
            (drivers if c > 0 else protective).append(item)
    reasons = [describe(d["feature"], d["value"], True) for d in drivers[:3]]
    if not reasons:
        reasons = ["No strong risk signal in the provided data"]
    out_of_range = [LABELS[n] for n, (lo, hi) in RANGES.items() if not (lo <= values[n] <= hi)]
    return reasons, drivers[:4], protective[:3], out_of_range


def describe(feature, value, raises):
    v = value
    if feature == "days_since_last_order":
        return f"{int(v)} days since the last order"
    if feature == "order_count":
        return f"Only {int(v)} order(s) so far" if raises else f"{int(v)} orders shows loyalty"
    if feature == "total_spent":
        return f"Lower lifetime spend (₹{v:,.0f})"
    if feature == "engagement_score":
        return f"Low engagement score ({v:.0f}/100)"
    if feature == "support_tickets":
        return f"{int(v)} support ticket(s) raised"
    if feature == "cart_value":
        return "No items waiting in cart" if v == 0 else f"Cart value ₹{v:,.0f}"
    return LABELS.get(feature, feature)


def recommendation(probability: float, f: CustomerFeatures):
    if f.cart_value > 0 and probability >= MEDIUM:
        return "Cart recovery email", "Free delivery or a small discount on the saved cart"
    if probability >= HIGH:
        if f.total_spent >= 50000:
            return "Personal VIP win-back email", "Exclusive 15–20% reward plus a personal note"
        return "Win-back email", "10–15% loyalty offer with a clear expiry date"
    if probability >= MEDIUM:
        return "Re-engagement email", "Personalised recommendations; small incentive only if they do not respond"
    return "Nurture (no discount needed)", "Helpful content or new arrivals — avoid giving away margin"


def predict_one(f: CustomerFeatures):
    x = np.array([getattr(f, name) for name in FEATURES], dtype=float)
    probability = float(MODEL.predict_proba(x.reshape(1, -1))[0][1])
    risk = "HIGH" if probability >= HIGH else ("MEDIUM" if probability >= MEDIUM else "LOW")
    reasons, drivers, protective, out_of_range = explain(f, contributions(x))
    action, offer = recommendation(probability, f)
    return {
        "churn_probability": round(probability, 4),
        "churn_percentage": round(probability * 100, 1),
        "risk": risk,
        "reasons": reasons,
        "drivers": drivers,
        "protective_factors": protective,
        "recommended_action": action,
        "recommended_channel": "Email",
        "recommended_offer": offer,
        "out_of_training_range": out_of_range,
        "model": {"provenance": MODEL_META.get("provenance"), "version": app.version},
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": "logistic-regression",
        "features": FEATURES,
        "thresholds": {"high": HIGH, "medium": MEDIUM},
        **MODEL_META,
    }


@app.post("/predict")
def predict(f: CustomerFeatures):
    return predict_one(f)


@app.post("/predict/batch")
def predict_batch(body: BatchRequest):
    return {"predictions": [predict_one(f) for f in body.customers]}
