# RecallIQ ML Service

FastAPI service that scores churn risk from six behavioural features:
`days_since_last_order, order_count, total_spent (INR), engagement_score (0–100), support_tickets, cart_value (INR)`.

```bash
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

| Endpoint | Purpose |
|---|---|
| `GET /health` | Status, **model provenance** (`synthetic` or `user-trained`), hold-out metrics |
| `POST /predict` | One customer → probability, LOW/MEDIUM/HIGH, reasons, model factors, action, offer |
| `POST /predict/batch` | `{ "customers": [...] }`, up to 1000 |

Invalid input (negative values, engagement > 100, missing fields) returns `422` with field details. The backend turns that into a readable `400`.

**Model honesty:** by default the model is trained at startup on synthetic data whose labels come from a hand-written rule. See [EVALUATION.md](EVALUATION.md). To use real data, run `python train_behavioral.py --data your.csv`.
