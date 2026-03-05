# ⚗️ Deploy Alchemy

> *You built the intelligence. We give it a voice.*

Deploy Alchemy is a stateless ML deployment UI that takes your Data Alchemy ZIP output and transforms it into a fully interactive prediction platform — no code, no config, no server storage.

---

## 🚀 Quick Start (Local Development)

### Prerequisites

- **Python 3.10+**
- **Node.js 18+**
- **npm 9+**

---

### Step 1 — Clone / Extract

```bash
cd deploy-alchemy
```

---

### Step 2 — Start the Backend

```bash
cd backend

# Create virtual environment (recommended)
python -m venv venv
source venv/bin/activate      # Mac/Linux
# or: venv\Scripts\activate   # Windows

# Install dependencies
pip install -r requirements.txt

# Start the API server
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

✅ Backend running at: http://localhost:8000
📖 API docs at: http://localhost:8000/docs

> ⚠️ **Note:** AutoGluon is a large library (~1-2GB). First install may take 5-10 minutes.

---

### Step 3 — Start the Frontend

Open a new terminal:

```bash
cd frontend

# Install dependencies
npm install

# Start dev server
npm run dev
```

✅ Frontend running at: http://localhost:5173

---

### Step 4 — Open Deploy Alchemy

Go to **http://localhost:5173** in your browser and drop your Data Alchemy ZIP file!

---

## 🐳 Docker (Full Stack)

If you prefer Docker (no Python/Node setup needed):

```bash
# From the deploy-alchemy root directory
docker-compose up --build
```

Then open **http://localhost:3000**

> First build takes longer due to AutoGluon install. Subsequent starts are fast.

---

## 📦 What Your ZIP Should Contain

Deploy Alchemy expects the ZIP output from Data Alchemy:

```
your_model.zip
├── 📁 AutoGluon model folder/     ← Folder with predictor.pkl
├── autofeat.pkl                   ← Feature engineering transformer  
├── features_eng.json              ← Feature schema & metadata
└── README.md                      ← Ignored automatically
```

File names can vary slightly — Deploy Alchemy auto-detects them.

---

## 🧭 Features

| Feature | Description |
|---|---|
| 🌀 Welcome Portal | Animated particle landing with drag-drop upload |
| 🔬 Model Scan | Live scan animation while artifacts are parsed |
| 🧠 Model Overview | Task type, best model, eval metric, feature count |
| 🏆 Leaderboard | Full AutoGluon model comparison table + chart |
| 📊 Analytics | Feature importance, score scatter, algorithm radar |
| 🎛️ Smart Prediction | Auto-built form with dropdowns/toggles/inputs |
| ⚠️ Validation | Range warnings, type errors, OOD detection |
| 📋 Batch Predict | Upload CSV → download predictions CSV |
| ⚡ What-If Builder | Vary one feature, see confidence chart |
| 📦 Export | Full deployment ZIP (Docker, Railway, Render, Fly.io) |
| 🗂️ Multi-Deployment | Upload multiple ZIPs, switch between them |

---

## 🔐 Privacy & Data

Deploy Alchemy is **fully stateless**:

- Uploaded files are processed in server memory / temporary directories
- Sessions expire after **2 hours of inactivity** and are auto-deleted
- When you close the browser, your session data is removed
- **Prediction history** is saved only in your browser's localStorage
- No data is written to any database or persistent storage

---

## 🏗️ Architecture

```
Frontend (React + Vite + Tailwind)
      ↕ HTTP/REST
Backend (FastAPI + Python)
      ↓
  Session Store (in-memory dict, TTL-based cleanup)
      ↓
  AutoGluon Predictor + autofeat.pkl (loaded per session)
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Tailwind CSS, Recharts, Framer Motion |
| Backend | FastAPI, Python 3.10 |
| ML | AutoGluon Tabular, autofeat |
| Data | Pandas, NumPy |
| Deployment | Docker, docker-compose |
| Fonts | Cinzel (display), Outfit (body), JetBrains Mono |

---

## ☁️ Production Deployment

### Railway (Recommended)

1. Push this repository to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add both `backend/` and `frontend/` as separate services
4. Set backend environment variable: `PORT=8000`
5. Set frontend nginx to proxy `/api/` to backend service URL

### Render

1. Push to GitHub
2. Create two Web Services on [render.com](https://render.com)
3. Backend: Python, `pip install -r requirements.txt`, `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Frontend: Static Site, `npm run build`, publish dir `dist`

---

## 🐛 Common Issues

**"AutoGluon model directory not found"**
→ Make sure your ZIP contains the AutoGluon predictor folder (should have `predictor.pkl` inside)

**"features_eng.json not found"**
→ Ensure the JSON file is inside the ZIP. Any filename containing `features` and `.json` will work.

**Backend install takes too long**
→ AutoGluon is large. Use a virtual environment and be patient on first install. Docker handles this automatically.

**Prediction fails with type error**
→ Check that your input values match the expected types shown in the form tooltips.

---

## 📝 Notes for Testing

When testing locally without a real Data Alchemy ZIP, you can create a minimal test ZIP:

```python
import pickle, json, zipfile, os
from autogluon.tabular import TabularPredictor
import pandas as pd

# Train a tiny test model
df = pd.DataFrame({'age': [25,30,35,40], 'income': [30000,50000,70000,90000], 'target': [0,0,1,1]})
predictor = TabularPredictor(label='target').fit(df, time_limit=30)
predictor.save('test_model/')

# Create minimal features_eng.json
features = {
  "features": [
    {"name": "age", "dtype": "int64", "min": 18, "max": 80, "median": 35},
    {"name": "income", "dtype": "float64", "min": 10000, "max": 200000, "median": 55000}
  ]
}
with open('features_eng.json', 'w') as f:
    json.dump(features, f)

# Zip it
with zipfile.ZipFile('test_model.zip', 'w') as zf:
    for root, dirs, files in os.walk('test_model/'):
        for file in files:
            zf.write(os.path.join(root, file))
    zf.write('features_eng.json')

print("test_model.zip created!")
```

---

*Built with ⚗️ by Deploy Alchemy*
