# Deploy Alchemy — GitHub + HuggingFace Deployment Guide

---

## PART 1 — Push to GitHub (Do This First)

### Step 1 — Initialize Git

```bash
# Open terminal inside your deploy-alchemy-fixed folder
cd /path/to/deploy-alchemy-fixed

git init
git branch -M main
```

### Step 2 — Create .gitignore

```bash
cat > .gitignore << 'EOF'
# Python
__pycache__/
*.pyc
*.pyo
.venv/
venv/
*.egg-info/

# Node
node_modules/
frontend/dist/
frontend/build/
.next/

# Runtime temp files (sessions/uploads)
/tmp/
*.tmp
/temp_sessions/

# Secrets
.env
.env.local
*.key

# OS
.DS_Store
Thumbs.db
EOF
```

### Step 3 — Commit everything

```bash
git add .
git commit -m "feat: Deploy Alchemy v3 — initial release"
```

### Step 4 — Create GitHub Repository

1. Go to → **https://github.com/new**
2. Repository name: `deploy-alchemy`
3. Visibility: **Public** ✅ (required for HuggingFace free Spaces)
4. Do NOT tick "Add README" or "Add .gitignore" (you have them already)
5. Click **Create repository**

### Step 5 — Push to GitHub

```bash
git remote add origin https://github.com/YOUR_USERNAME/deploy-alchemy.git
git push -u origin main
```

### Step 6 — Future updates (every time you change code)

```bash
git add .
git commit -m "fix: describe your change"
git push
# → HuggingFace auto-rebuilds within ~2 minutes
```

---

## PART 2 — HuggingFace Spaces (16GB RAM, FREE)

HuggingFace Spaces with Docker gives you:
- ✅ **16GB RAM** (free tier)
- ✅ **2 vCPU**
- ✅ **50GB storage**
- ✅ Persistent URL: `https://huggingface.co/spaces/YOUR_HF_USERNAME/deploy-alchemy`
- ✅ Auto-redeploy from GitHub pushes
- ✅ No credit card required

---

### Step 1 — Create HuggingFace Account

Go to **https://huggingface.co/join** and register.

---

### Step 2 — Create a new Space

1. Go to → **https://huggingface.co/new-space**
2. Fill in:
   - **Space name**: `deploy-alchemy`
   - **License**: MIT (or your choice)
   - **SDK**: **Docker** ← Important, select Docker
   - **Hardware**: `CPU basic · 2 vCPU · 16GB` (free)
   - **Visibility**: Public
3. Click **Create Space**

---

### Step 3 — Create the Dockerfile for HuggingFace

HuggingFace requires apps to run on **port 7860**. Create this file at the ROOT of your project:

```dockerfile
# Dockerfile  (save this at: deploy-alchemy-fixed/Dockerfile)

# ── Stage 1: Build React frontend ──────────────────────────────────────────
FROM node:18-slim AS frontend-builder

WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci --silent
COPY frontend/ ./
RUN npm run build
# Output: /build/dist/

# ── Stage 2: Python backend + serve frontend ────────────────────────────────
FROM python:3.10-slim

# System deps for AutoGluon, LightGBM, PyTorch
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libgomp1 git curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first (cache layer)
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY backend/ ./backend/

# Copy built frontend into static/
COPY --from=frontend-builder /build/dist ./static/

# HuggingFace runs on port 7860 (NOT 8000)
ENV PORT=7860
EXPOSE 7860

# Entrypoint
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "7860"]
```

---

### Step 4 — Update backend to serve the React frontend

Add these lines to **`backend/main.py`** near the bottom, just BEFORE the `@app.get("/health")` route:

```python
# ── Serve React frontend (production build) ─────────────────────────────────
import os
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")

if os.path.isdir(STATIC_DIR):
    # Serve /assets/, /favicon etc
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

    @app.get("/", include_in_schema=False)
    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str = ""):
        # Don't intercept API routes
        if full_path.startswith("api/") or full_path in ("health", "model-info", "predict", "predict-batch", "test-model"):
            raise HTTPException(404)
        index = os.path.join(STATIC_DIR, "index.html")
        if os.path.isfile(index):
            return FileResponse(index)
        raise HTTPException(404)
```

---

### Step 5 — Add backend/requirements.txt with autogluon[all]

Make sure your `backend/requirements.txt` contains:

```
fastapi
uvicorn[standard]
python-multipart
pandas
numpy
scikit-learn
autofeat
autogluon.tabular[all]
```

`autogluon.tabular[all]` installs **lightgbm, xgboost, catboost, torch** — no missing library errors.

---

### Step 6 — Connect HuggingFace Space to GitHub

This is the magic step — after this, every `git push` auto-deploys.

1. Go to your Space → **Settings** tab
2. Scroll down to **"Repository"** section
3. Click **"Link to GitHub repository"**
4. Authorize HuggingFace on GitHub
5. Select: `YOUR_USERNAME/deploy-alchemy`
6. Branch: `main`
7. Click **Save**

Now HuggingFace will:
- Pull your repo
- Build the Docker image
- Deploy it
- **Re-deploy automatically on every push to main**

---

### Step 7 — First Deployment

After linking GitHub:

```bash
# Back on your machine — push the Dockerfile + main.py updates
git add .
git commit -m "feat: add HuggingFace Docker setup"
git push
```

Watch the build in HuggingFace → your Space → **"Logs"** tab.
First build takes ~10-15 minutes (installs autogluon). Subsequent builds: ~3-5 min.

---

### Step 8 — Access your app

Your app will be live at:
```
https://huggingface.co/spaces/YOUR_HF_USERNAME/deploy-alchemy
```

---

## Platform Comparison Table

| Platform | RAM | Storage | Price | Auto-deploy | Notes |
|----------|-----|---------|-------|-------------|-------|
| **HuggingFace Spaces** | **16 GB** | 50 GB | **FREE** | ✅ via GitHub | Best free option |
| Railway | 512 MB free / 8GB paid | 100 GB | $5–20/mo | ✅ native | Easiest paid |
| Render | 512 MB free / 2GB+ paid | Ephemeral | $7–50/mo | ✅ native | Free spins down |
| Fly.io | 256 MB free / 4GB paid | 3 GB vol | $3–20/mo | ✅ via Actions | Global edge |
| Hetzner CX21 | 4 GB | 40 GB | €4/mo | ✅ via Actions | Cheapest paid |
| Oracle Cloud | **24 GB ARM** | 200 GB | **FREE** | Manual | Complex setup |

**Verdict:** HuggingFace is the clear winner for your use case — 16GB RAM handles AutoGluon models easily, GitHub auto-deploy means every `git push` goes live automatically, and it's completely free.

---

## PART 3 — Error Handling Reference

All errors in Deploy Alchemy now return structured JSON:

```json
{
  "detail": "Human-readable error message explaining what went wrong and how to fix it"
}
```

### CSV Validation Errors (new in this version)

| Error | Cause | Fix |
|-------|-------|-----|
| `❌ Wrong file — no matching columns` | Uploaded diabetes.csv for a laptop model | Upload the original training CSV |
| `❌ Wrong CSV — only X% columns matched` | Different dataset, same domain | Check you have the right file |
| `⚠️ N columns auto-filled` | Partial match, some cols missing | OK — predictions will work, missing cols use training medians |

### Deployment Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `lightgbm not installed` | Old requirements.txt | Run: `pip install autogluon.tabular[all]` |
| `torch not installed` | Model uses NeuralNet | Same: `pip install autogluon.tabular[all]` |
| `catboost not installed` | Model uses CatBoost | Same fix |
| `Target column 'X' not found` | Test CSV missing target | Add the target column to your CSV |
| `Cannot parse CSV` | File is not valid CSV | Check file encoding, commas, headers |
| `Session not found` | Server restarted, session expired | Re-upload your model ZIP |

---

## Quick Reference

```bash
# Push update to GitHub → auto-deploys to HuggingFace
git add . && git commit -m "your message" && git push

# View HuggingFace build logs
# → https://huggingface.co/spaces/YOUR_HF/deploy-alchemy (Logs tab)

# Force rebuild on HuggingFace (if needed)
# → Settings → Factory reboot

# Check if app is up
curl https://huggingface.co/spaces/YOUR_HF/deploy-alchemy/api/health
```
