# ML Evaluation

## Runtime model (what the app uses)

| | |
|---|---|
| Algorithm | Logistic regression (standardised features) |
| Default training data | 6,000 **synthetic** customers, generated in `synthetic_dataset()` |
| Labels | Produced by a hand-written logistic rule plus random noise. This rule *is* the synthetic assumption. |
| Hold-out (25%) | ROC-AUC ≈ 0.83, accuracy ≈ 0.75 (exact values at `GET /health`) |

These metrics only measure how well the model recovers the synthetic rule. They are **not** evidence that
RecallIQ predicts real churn, and they should not be quoted on a CV or in a demo without that caveat.

Explanations are derived from the fitted model (coefficient × standardised value per feature), so they
reflect what the model actually uses rather than separate if/else text.

## Validating on real data

`train_behavioral.py` trains the same pipeline on your CSV (six features plus an observed `churned` label)
with a stratified 80/20 split, and records ROC-AUC, accuracy, precision, recall and F1 in
`model_artifacts/behavioral_model.json`. Requirements for an honest evaluation:

- Features measured at a snapshot date; the label observed in a window **after** it (e.g. no purchase in the next 90 days).
- At least a few hundred rows of each class.
- Ideally a time-based split (train on older snapshots, test on newer), which is stricter than a random split.

## Separate Telco pipeline

`train.py` evaluates a classifier on the public IBM Telco Customer Churn dataset (a different schema:
tenure, contract, charges…). It shows a reproducible evaluation workflow. It does not feed the app.
