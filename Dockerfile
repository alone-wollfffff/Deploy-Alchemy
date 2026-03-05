# ════════════════════════════════════════════════════════════════════
#  Deploy Alchemy — HuggingFace Spaces Dockerfile
#  Single container: builds React, serves via FastAPI on port 7860
# ════════════════════════════════════════════════════════════════════

# ── Stage 1: Build React frontend ────────────────────────────────────
FROM node:20-slim AS frontend-builder

WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci --silent
COPY frontend/ ./
RUN npm run build
# Output goes to /build/dist/

# ── Stage 2: Python backend + serve frontend ─────────────────────────
FROM python:3.10-slim

# System deps for AutoGluon / LightGBM / PyTorch
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libgomp1 git curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies (cached layer — only rebuilds if requirements.txt changes)
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ ./backend/

# Copy built React app into /app/static/ so FastAPI can serve it
COPY --from=frontend-builder /build/dist ./static/

# HuggingFace Spaces REQUIRES port 7860
ENV PORT=7860
EXPOSE 7860

# Run FastAPI — serves both /api/* endpoints AND the React SPA
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1"]
