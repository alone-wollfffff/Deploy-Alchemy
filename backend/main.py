import os, uuid, json, shutil, zipfile, pickle, tempfile, threading, time, io, traceback, re
from typing import Optional, Any
import numpy as np
import pandas as pd
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI(title="Deploy Alchemy API", version="3.1.0")

from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request, exc):
    errors = [f"{' → '.join(str(x) for x in e['loc'] if x != 'body')}: {e['msg']}" for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": "Invalid request. " + "; ".join(errors)})

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])


# ── CSV Schema Validator ─────────────────────────────────────────────────────

def _validate_csv_schema(df: pd.DataFrame, schema: list, context: str = "batch") -> dict:
    """
    Validates an uploaded CSV against the model's expected feature schema.
    Threshold-based rejection so wrong-dataset uploads (diabetes.csv vs laptop.csv)
    are caught immediately with a clear human-readable error.

    match_pct < 10%  → hard reject  (definitely wrong file)
    match_pct < 40%  → soft reject  (probably wrong file)
    match_pct >= 40% → accept + warn about missing cols (auto-filled with medians)
    """
    if not schema:
        return {"valid": True, "match_pct": 1.0, "matched": [], "missing": [], "extra": [], "warning": None, "error": None}

    schema_cols = [f["name"] for f in schema]
    schema_set  = set(schema_cols)
    upload_set  = set(df.columns.tolist())

    matched  = schema_set & upload_set
    missing  = schema_set - upload_set
    extra    = upload_set - schema_set
    n_schema = len(schema_cols)
    match_pct = len(matched) / n_schema

    # ── HARD REJECT: 0 overlap ─────────────────────────────────────────────
    if match_pct == 0:
        return {
            "valid": False, "match_pct": 0.0,
            "matched": [], "missing": sorted(list(missing))[:8], "extra": sorted(list(extra))[:8],
            "error": (
                f"❌ Wrong file uploaded — no matching columns found.\n\n"
                f"This model was trained on data with columns like:\n"
                f"  {', '.join(sorted(list(schema_set))[:6])}\n\n"
                f"Your uploaded file has:\n"
                f"  {', '.join(sorted(list(extra))[:6])}\n\n"
                f"These look like completely different datasets. Please upload the "
                f"correct CSV file that matches this model."
            ),
            "warning": None
        }

    # ── HARD REJECT: < 10% overlap ─────────────────────────────────────────
    if match_pct < 0.10:
        return {
            "valid": False, "match_pct": round(match_pct, 3),
            "matched": sorted(list(matched)), "missing": sorted(list(missing))[:8], "extra": sorted(list(extra))[:8],
            "error": (
                f"❌ Wrong CSV file — only {int(match_pct*100)}% of required columns found "
                f"({len(matched)} of {n_schema}).\n\n"
                f"Matched: {', '.join(sorted(list(matched))[:4])}\n"
                f"Expected (sample): {', '.join(sorted(list(missing))[:5])}\n\n"
                f"This looks like a different dataset. Please upload the original CSV "
                f"file that was used to train this model."
            ),
            "warning": None
        }

    # ── SOFT REJECT: < 40% overlap ─────────────────────────────────────────
    if match_pct < 0.40:
        return {
            "valid": False, "match_pct": round(match_pct, 3),
            "matched": sorted(list(matched)), "missing": sorted(list(missing))[:8], "extra": sorted(list(extra))[:8],
            "error": (
                f"❌ Possibly wrong CSV file — only {int(match_pct*100)}% column match "
                f"({len(matched)} of {n_schema} required columns found).\n\n"
                f"✅ Found: {', '.join(sorted(list(matched))[:5])}\n"
                f"❌ Missing: {', '.join(sorted(list(missing))[:5])}\n\n"
                f"If this is the correct file, some columns may have been renamed. "
                f"Otherwise, please upload the original training data CSV."
            ),
            "warning": None
        }

    # ── ACCEPT with optional warning ────────────────────────────────────────
    warning = None
    if missing:
        warning = (
            f"⚠️ {len(missing)} column(s) not found in uploaded file — "
            f"will be auto-filled with training medians/defaults: "
            f"{', '.join(sorted(list(missing))[:5])}"
            + (f" and {len(missing)-5} more..." if len(missing) > 5 else "")
        )

    return {
        "valid": True, "match_pct": round(match_pct, 3),
        "matched": sorted(list(matched)), "missing": sorted(list(missing)),
        "extra": sorted(list(extra)), "warning": warning, "error": None
    }


SESSIONS: dict = {}
SESSION_TTL = 7200

# ── Column sanitization (mirrors Data Alchemy logic exactly) ──────────────────

def sanitize_col(name: str) -> str:
    """Match the exact sanitization Data Alchemy applies on CSV import."""
    name = str(name).strip()
    name = re.sub(r'[\s\-]+', '_', name)   # spaces / hyphens → underscore
    name = re.sub(r'[^\w]', '', name)       # remove non-word chars
    name = re.sub(r'_+', '_', name)        # collapse multiple underscores
    return name.strip('_')

def sanitize_df(df: pd.DataFrame) -> pd.DataFrame:
    """Sanitize all column names of a DataFrame in-place copy."""
    df = df.copy()
    df.columns = [sanitize_col(c) for c in df.columns]
    return df

# ── Session helpers ───────────────────────────────────────────────────────────

def cleanup_session(sid):
    if sid in SESSIONS:
        sess = SESSIONS.pop(sid)
        td = sess.get("temp_dir")
        if td and os.path.exists(td):
            shutil.rmtree(td, ignore_errors=True)

def ttl_cleaner():
    while True:
        time.sleep(300)
        now = time.time()
        for s in [s for s, d in list(SESSIONS.items())
                  if now - d.get("last_access", 0) > SESSION_TTL]:
            cleanup_session(s)

threading.Thread(target=ttl_cleaner, daemon=True).start()

# ── File discovery ────────────────────────────────────────────────────────────

def find_autogluon_dir(directory):
    for root, dirs, files in os.walk(directory):
        if "predictor.pkl" in files:
            return root
    return None

def find_file(directory, keywords):
    for root, dirs, files in os.walk(directory):
        for f in files:
            fl = f.lower()
            for kw in keywords:
                if kw.lower() in fl:
                    return os.path.join(root, f)
    return None

def find_csv_file(directory):
    """Find processed_data.csv first, then any CSV at the top level of the ZIP."""
    # Priority: files named 'processed_data' or containing 'processed'
    for root, dirs, files in os.walk(directory):
        for f in files:
            if f.lower() in ("processed_data.csv", "data.csv", "train.csv", "dataset.csv"):
                return os.path.join(root, f)
    # Fallback: any .csv (skip subdirs first — prefer top-level)
    top_level = [f for f in os.listdir(directory) if f.lower().endswith('.csv')]
    if top_level:
        return os.path.join(directory, top_level[0])
    # Deep search
    for root, dirs, files in os.walk(directory):
        for f in files:
            if f.lower().endswith('.csv'):
                return os.path.join(root, f)
    return None

def find_profile_report(directory):
    """Find profile_report.html or any HTML profiling report in the ZIP."""
    for root, dirs, files in os.walk(directory):
        for f in files:
            fl = f.lower()
            if fl.endswith('.html') and any(k in fl for k in ('profile', 'report', 'profil', 'eda')):
                return os.path.join(root, f)
    return None

def load_training_X(ag_dir):
    path = os.path.join(ag_dir, "utils", "data", "X.pkl")
    if os.path.exists(path):
        try:
            return pd.read_pickle(path)
        except Exception:
            pass
    return None

def safe_json(obj):
    """Recursively make obj safe for JSON. NaN/Inf -> None, numpy types -> Python types."""
    import math as _m
    if obj is None: return None
    if isinstance(obj, bool): return obj
    if isinstance(obj, np.integer): return int(obj)
    if isinstance(obj, np.floating):
        f = float(obj)
        return None if (_m.isnan(f) or _m.isinf(f)) else f
    if isinstance(obj, float):
        return None if (_m.isnan(obj) or _m.isinf(obj)) else obj
    if isinstance(obj, np.ndarray): return [safe_json(v) for v in obj.tolist()]
    if isinstance(obj, pd.Series):  return [safe_json(v) for v in obj.tolist()]
    if isinstance(obj, dict):       return {str(k): safe_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)): return [safe_json(i) for i in obj]
    # catch remaining numpy scalars
    try:
        f = float(obj)
        import math as _m2
        return None if (_m2.isnan(f) or _m2.isinf(f)) else f
    except (TypeError, ValueError):
        pass
    return obj

# ── Value coercion ────────────────────────────────────────────────────────────

def apply_feature_engineering(df: pd.DataFrame, autofeat, added_features: dict) -> pd.DataFrame:
    """
    Add engineered features to df before passing to AutoGluon.

    Strategy:
    1. Try autofeat.transform() first (if available).
    2. Regardless of whether autofeat worked, ensure every feature listed in
       added_features is present by evaluating its formula string with
       pandas.eval().  This is the reliable fallback because the feature names
       in added_features ARE the formulas (e.g. 'SSD**2/Ram').

    AutoGluon was trained on data that already contained these columns, so
    they MUST exist in the DataFrame at predict-time or AutoGluon raises a
    KeyError.
    """
    # Step 1 — autofeat transform (may add more columns than listed in added_features)
    if autofeat is not None:
        try:
            df = autofeat.transform(df.copy())
        except Exception:
            pass  # fall through to manual computation

    # Step 2 — manually compute any still-missing engineered columns
    for col_name, formula in added_features.items():
        if col_name not in df.columns:
            try:
                # pandas.eval handles ** / * + - on column references
                df[col_name] = df.eval(formula)
            except Exception:
                try:
                    # Fallback: plain Python eval with column dict
                    row_dict = df.iloc[0].to_dict()
                    val = eval(formula, {"__builtins__": {}}, row_dict)
                    df[col_name] = val
                except Exception:
                    df[col_name] = 0  # last resort — column must exist

    return df


def coerce_value(val: Any, feat: dict) -> Any:
    """
    Coerce a user-supplied value to the correct Python type for AutoGluon.

    Critical fix: AutoGluon stores categorical columns with dtype 'category'
    whose categories are integers (0, 1, 2...).  The frontend sends string "0",
    "1" etc., so we must convert to int.  Without this the model crashes.
    """
    if val is None:
        return val

    dtype = str(feat.get("dtype", ""))

    needs_numeric = (
        "int"      in dtype or
        "float"    in dtype or
        "category" in dtype   # ← AutoGluon categoricals are int-coded
    )

    if needs_numeric:
        try:
            f = float(str(val).strip())
            return int(f) if "float" not in dtype else f
        except (ValueError, TypeError):
            pass

    return val

# ── Schema building ───────────────────────────────────────────────────────────

def pick_widget(col, dtype, unique_vals, val_range, real_labels=None):
    """
    Choose the best UI widget for a feature column.

    Priority:
    1. Real labels from CSV → labeled_dropdown (even for binary columns)
    2. Binary (0/1 only) → toggle
    3. String categorical → dropdown
    4. Integer with few unique values → encoded_dropdown (shows actual int values)
    5. Fallback → number input
    """
    dtype = str(dtype)
    n = len(unique_vals) if unique_vals else 9999

    # Real labels from uploaded CSV → always use labeled_dropdown
    # This takes priority over toggle — so "Sex: 0/1" becomes "female/male" dropdown
    if real_labels and 2 <= len(real_labels) <= 50:
        opts = [{"value": str(k), "label": str(v)}
                for k, v in sorted(real_labels.items(), key=lambda x: (str(x[0]), x[0]))]
        return {"widget": "labeled_dropdown", "options": opts}

    # Boolean toggle (only values 0 and 1, no real labels)
    if unique_vals and len(unique_vals) <= 2 and \
       set(str(v).lower() for v in unique_vals) <= {'0', '1'}:
        return {"widget": "toggle"}

    # String / object categorical (pandas 2.x uses 'str'/'string' dtype)
    if ("object" in dtype or "str" in dtype or "string" in dtype or
            ("category" in dtype and any(isinstance(v, str) for v in unique_vals))):
        if n <= 25:
            return {"widget": "dropdown",
                    "options": [str(v) for v in sorted(unique_vals, key=str)]}
        return {"widget": "text"}

    # Integer encoded with few unique values → show as dropdown with actual int labels
    if ("int" in dtype or "float" in dtype or "category" in dtype) and 2 < n <= 20:
        try:
            nums = sorted(set(int(float(v)) for v in unique_vals))
            if all(float(v) == int(float(v)) for v in unique_vals):
                opts = [{"value": str(v), "label": str(v)} for v in nums]
                return {"widget": "encoded_dropdown", "options": opts}
        except Exception:
            pass

    return {
        "widget": "number",
        "min":    val_range.get("min"),
        "max":    val_range.get("max"),
        "median": val_range.get("median"),
    }


def schema_from_df(df: pd.DataFrame, target_col: str,
                   added_features: dict, csv_labels: dict = None) -> list:
    exclude = {target_col} | set(added_features.keys()) | set(added_features.values())
    schema  = []

    for col in df.columns:
        if col in exclude:
            continue
        s     = df[col].dropna()
        dtype = str(df[col].dtype)
        n_u   = int(s.nunique())

        unique_vals = []
        if n_u <= 50:
            unique_vals = [v for v in s.unique().tolist() if v == v]

        val_range = {}
        if "int" in dtype or "float" in dtype or "category" in dtype:
            try:
                val_range = {
                    "min":    float(s.min()),
                    "max":    float(s.max()),
                    "median": float(s.median()),
                }
            except Exception:
                pass

        mode_val = None
        try:
            mv = s.mode().iloc[0]
            mode_val = (int(mv)   if isinstance(mv, (np.integer,))
                        else float(mv) if isinstance(mv, (np.floating,))
                        else str(mv))
        except Exception:
            pass

        real_labels = (csv_labels or {}).get(col)
        w = pick_widget(col, dtype, unique_vals, val_range, real_labels)

        schema.append({
            "name":    col,
            "dtype":   dtype,
            "n_unique": n_u,
            "widget":  w["widget"],
            "options": w.get("options"),
            "min":     w.get("min")    or val_range.get("min"),
            "max":     w.get("max")    or val_range.get("max"),
            "median":  w.get("median") or val_range.get("median"),
            "mode":    mode_val,
        })

    return schema


def extract_csv_labels(csv_df: pd.DataFrame, encoded_df: pd.DataFrame,
                       target_col: str, added_features: dict) -> dict:
    """
    Build {col: {int_code: real_label}} mapping.

    Strategy — row-by-row positional alignment is the most reliable approach:
      - For every column that appears in BOTH the encoded training X and the raw CSV
      - If encoded values are numeric/codes AND csv values are strings → build mapping
      - Also handles integer-to-integer columns (e.g. Pclass 1/2/3 stays 1/2/3)
    """
    labels  = {}
    # Sanitize exclude set: both raw names and sanitized names
    import re as _re

    def _san(s):
        s = str(s).strip()
        s = _re.sub(r'[\s\-]+', '_', s)
        s = _re.sub(r'[^\w]', '', s)
        s = _re.sub(r'_+', '_', s)
        return s.strip('_')

    exclude = (
        {target_col, _san(target_col)} |
        {_san(k) for k in added_features.keys()} |
        {_san(v) for v in added_features.values()} |
        set(added_features.keys()) |
        set(added_features.values())
    )

    for col in encoded_df.columns:
        if col in exclude or col not in csv_df.columns:
            continue

        enc_full = encoded_df[col]
        raw_full = csv_df[col]
        enc_dtype = str(enc_full.dtype)
        csv_dtype = str(raw_full.dtype)

        # Is the CSV column a string/object type?
        is_csv_str = any(t in csv_dtype for t in ('object', 'str', 'string', 'category'))
        # Is the CSV column an integer/float type?
        is_csv_num = any(t in csv_dtype for t in ('int', 'float'))

        # ── Unified row-by-row positional alignment ────────────────────────
        # Works for:
        #   • int8/int64 encoded + object CSV  (e.g. Sex: 0/1 → female/male)
        #   • category int-coded + object CSV  (e.g. Embarked: 0-3 → S/C/Q)
        #   • int encoded + int CSV with few values (e.g. Pclass: 1,2,3)
        try:
            # Get parallel series WITH index alignment (use reset_index for safety)
            enc_s = enc_full.reset_index(drop=True)
            raw_s = raw_full.reset_index(drop=True)

            # For category dtype, the stored values are already the integer codes
            if "category" in enc_dtype:
                # .astype(object) converts category values to their actual stored ints
                enc_s = enc_s.cat.codes  # -1 for NaN, 0..n for values
                # We need the actual category values, not codes
                enc_s = enc_full.reset_index(drop=True).astype(object)

            # Build mask of rows that have valid values in BOTH columns
            enc_valid = enc_s.notna()
            raw_valid = raw_s.notna() & (raw_s.astype(str) != 'nan')
            mask = enc_valid & raw_valid

            enc_aligned = enc_s[mask]
            raw_aligned = raw_s[mask]

            if len(enc_aligned) == 0:
                continue

            mapping = {}
            for e_val, c_val in zip(enc_aligned.values, raw_aligned.values):
                try:
                    k = int(float(str(e_val)))
                except (ValueError, TypeError):
                    continue
                c_str = str(c_val).strip()
                if c_str in ('nan', 'None', '') or not c_str:
                    continue
                if k not in mapping:
                    mapping[k] = c_str

            if not mapping:
                continue

            # Filter 1: too many unique values → not useful as a dropdown
            if len(mapping) > 30:
                continue

            # Decide if this mapping is useful:
            # • String labels (is_csv_str): useful if values are real strings OR few int-strings
            # • Integer/float labels (is_csv_num): only useful if few unique values (categorical-ish)
            if is_csv_str:
                # Check there are actual non-numeric string labels
                has_real_str = any(
                    not v.replace('.', '', 1).lstrip('-').isdigit()
                    for v in mapping.values()
                )
                if has_real_str:
                    labels[col] = mapping
                elif len(mapping) <= 20:
                    # Numeric string values but few of them → keep (e.g. Pclass "1","2","3")
                    labels[col] = mapping
            elif is_csv_num:
                # Both numeric — only categorical-ish columns (few unique values)
                if len(mapping) <= 20:
                    labels[col] = mapping

        except Exception:
            pass  # non-fatal, skip this column

    return labels

# ── Upload ZIP ────────────────────────────────────────────────────────────────

@app.post("/api/upload")
async def upload_zip(file: UploadFile = File(...)):
    session_id = str(uuid.uuid4())
    temp_dir   = tempfile.mkdtemp(prefix=f"da_{session_id}_")
    try:
        # ── Stream-write ZIP to disk (handles large files without OOM) ─────
        zip_path    = os.path.join(temp_dir, "u.zip")
        extract_dir = os.path.join(temp_dir, "ext")
        os.makedirs(extract_dir)

        with open(zip_path, "wb") as dst:
            while True:
                chunk = await file.read(1024 * 1024)  # 1 MB chunks
                if not chunk:
                    break
                dst.write(chunk)

        # ── Extract ZIP safely ─────────────────────────────────────────────
        try:
            with zipfile.ZipFile(zip_path) as z:
                # Guard against zip-slip attacks and filter bad entries
                for member in z.namelist():
                    member_path = os.path.realpath(os.path.join(extract_dir, member))
                    if not member_path.startswith(os.path.realpath(extract_dir)):
                        continue  # skip unsafe paths
                z.extractall(extract_dir)
        except zipfile.BadZipFile:
            raise HTTPException(400, "Invalid ZIP file — could not open. "
                                "Make sure you're uploading a valid .zip from Data Alchemy.")
        except Exception as e:
            raise HTTPException(400, f"ZIP extraction failed: {e}")

        # ── AutoGluon dir ──────────────────────────────────────────────────
        ag_dir = find_autogluon_dir(extract_dir)
        if not ag_dir:
            raise HTTPException(400,
                "AutoGluon model not found in ZIP.\n\n"
                "Expected structure:\n"
                "  your_model.zip\n"
                "  ├── autogluon_model/\n"
                "  │   └── predictor.pkl  ← required\n"
                "  ├── autofeat_model.pkl\n"
                "  ├── feature_engineering.json\n"
                "  ├── processed_data.csv\n"
                "  └── profile_report.html\n\n"
                "Make sure your ZIP was exported from Data Alchemy.")

        # ── Optional autofeat ──────────────────────────────────────────────
        autofeat_path = find_file(extract_dir, ["autofeat"])
        autofeat_obj, has_autofeat = None, False
        if autofeat_path:
            try:
                with open(autofeat_path, "rb") as f:
                    autofeat_obj = pickle.load(f)
                has_autofeat = True
            except Exception:
                pass  # non-fatal

        # ── Optional features JSON ─────────────────────────────────────────
        feat_json_path = find_file(extract_dir,
            ["feature_engineering", "features_eng", "features.json"])
        feat_json = {}
        if feat_json_path:
            try:
                with open(feat_json_path) as f:
                    feat_json = json.load(f)
            except Exception:
                pass

        added_features   = (feat_json.get("added_features") or
                             feat_json.get("engineered_features") or {})
        target_from_json = (feat_json.get("automl_target") or
                            feat_json.get("target") or
                            feat_json.get("label"))

        # ── Load AutoGluon ─────────────────────────────────────────────────
        try:
            from autogluon.tabular import TabularPredictor
            predictor = TabularPredictor.load(ag_dir, require_py_version_match=False)
        except ImportError:
            raise HTTPException(500,
                "AutoGluon is not installed on this server. "
                "Install with: pip install autogluon.tabular")
        except Exception as e:
            err_str = str(e)
            hint = ""
            if "version" in err_str.lower():
                hint = " (Version mismatch — model was saved with a different Python/AutoGluon version)"
            elif "pickle" in err_str.lower() or "unpickling" in err_str.lower():
                hint = " (Pickle error — model file may be corrupt or incompatible)"
            raise HTTPException(500, f"AutoGluon load failed{hint}: {err_str}")

        target_col = predictor.label or target_from_json or "target"

        # Build schema from training data
        training_df  = load_training_X(ag_dir)
        input_schema = []

        if training_df is not None and len(training_df.columns) > 0:
            input_schema = schema_from_df(training_df, target_col, added_features)
        else:
            # Fallback to AutoGluon feature metadata
            try:
                fm       = predictor.feature_metadata_in
                ag_types = getattr(fm, 'type_map_raw', {})
                for col, dtype in ag_types.items():
                    if col == target_col:
                        continue
                    input_schema.append({
                        "name": col, "dtype": str(dtype), "n_unique": 999,
                        "widget": "number" if ("float" in str(dtype) or
                                               "int" in str(dtype)) else "text",
                        "options": None, "min": None, "max": None,
                        "median": None,  "mode": None,
                    })
            except Exception:
                pass

        # ── Auto-detect CSV and profile report from ZIP ───────────────────
        csv_path_found    = find_csv_file(extract_dir)
        profile_rpt_path  = find_profile_report(extract_dir)
        auto_csv_enriched = False

        # Auto-enrich schema with real labels if CSV is present
        if csv_path_found and training_df is not None and len(training_df.columns) > 0:
            try:
                csv_df = pd.read_csv(csv_path_found)
                csv_df = sanitize_df(csv_df)
                csv_labels = extract_csv_labels(csv_df, training_df, target_col, added_features)
                if csv_labels:
                    input_schema      = schema_from_df(training_df, target_col, added_features,
                                                       csv_labels=csv_labels)
                    auto_csv_enriched = True
            except Exception:
                pass  # Non-fatal — fall back to numeric schema

        metadata = build_metadata(predictor, input_schema, feat_json,
                                  has_autofeat, added_features)

        # Reflect auto-enrichment in metadata
        if auto_csv_enriched:
            metadata["csv_enriched"]           = True
            metadata["input_schema"]           = input_schema
            metadata["num_features_original"]  = len(input_schema)

        SESSIONS[session_id] = {
            "predictor":           predictor,
            "autofeat":            autofeat_obj,
            "has_autofeat":        has_autofeat,
            "added_features":      added_features,
            "target_col":          target_col,
            "training_df":         training_df,
            "metadata":            metadata,
            "temp_dir":            temp_dir,
            "last_access":         time.time(),
            "deployment_name":     file.filename.replace(".zip", ""),
            "csv_path":            csv_path_found,
            "profile_report_path": profile_rpt_path,
        }

        return {
            "session_id": session_id,
            "metadata":   safe_json(metadata),
            "files_found": {
                "autogluon":          True,
                "autofeat":           has_autofeat,
                "features_json":      bool(feat_json_path),
                "has_csv":            bool(csv_path_found),
                "has_profile_report": bool(profile_rpt_path),
                "csv_auto_enriched":  auto_csv_enriched,
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(500, f"Upload error: {e}\n{traceback.format_exc()}")


# ── CSV label enrichment ──────────────────────────────────────────────────────

@app.post("/api/session/{sid}/enrich-csv")
async def enrich_with_csv(sid: str, file: UploadFile = File(...)):
    """
    User uploads the original training CSV so we can replace encoded
    integers with real string labels (e.g. 0→'Apple', 1→'HP').

    IMPORTANT: We sanitize column names exactly as Data Alchemy does,
    so 'Cpu Brand' in the CSV maps to 'Cpu_Brand' in the model.
    """
    if sid not in SESSIONS:
        raise HTTPException(404, "Session not found")
    sess = SESSIONS[sid]
    sess["last_access"] = time.time()

    content = await file.read()
    try:
        csv_df = pd.read_csv(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(400, f"Cannot parse CSV file: {e}. Make sure the file is a valid .csv")

    csv_df = sanitize_df(csv_df)

    schema  = sess["metadata"]["input_schema"]
    chk     = _validate_csv_schema(csv_df, schema, context="label enrichment")
    if not chk["valid"]:
        raise HTTPException(400, chk["error"])

    training_df    = sess.get("training_df")
    target_col     = sess["target_col"]
    added_features = sess.get("added_features", {})

    if training_df is None:
        raise HTTPException(400, "No training data stored for this session")

    csv_labels = extract_csv_labels(csv_df, training_df, target_col, added_features)

    if not csv_labels:
        return {
            "message":          "No categorical mappings found (all columns may already be numeric)",
            "enriched_columns": [],
            "updated_schema":   safe_json(sess["metadata"]["input_schema"]),
        }

    new_schema = schema_from_df(training_df, target_col, added_features,
                                csv_labels=csv_labels)
    sess["metadata"]["input_schema"]       = new_schema
    sess["metadata"]["num_features_original"] = len(new_schema)
    sess["metadata"]["csv_enriched"]       = True

    return {
        "message":          f"Enriched {len(csv_labels)} columns with real labels",
        "enriched_columns": list(csv_labels.keys()),
        "updated_schema":   safe_json(new_schema),
    }


# ── Profile Report ────────────────────────────────────────────────────────────

@app.get("/api/session/{sid}/profile-report")
def get_profile_report(sid: str):
    """
    Return the EDA / profiling HTML report that was bundled in the uploaded ZIP.
    The frontend renders it inside an <iframe>.
    """
    if sid not in SESSIONS:
        raise HTTPException(404, "Session not found")
    sess = SESSIONS[sid]
    sess["last_access"] = time.time()
    path = sess.get("profile_report_path")
    if not path or not os.path.exists(path):
        raise HTTPException(404, "No profile report found in this ZIP. "
                            "Make sure your ZIP contains a profile_report.html file.")
    from fastapi.responses import HTMLResponse
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            content = f.read()
        return HTMLResponse(content=content)
    except Exception as e:
        raise HTTPException(500, f"Could not read profile report: {e}")




def build_metadata(predictor, input_schema, feat_json,
                   has_autofeat, added_features):
    m = {
        "problem_type":        predictor.problem_type,
        "eval_metric":         str(predictor.eval_metric),
        "label":               predictor.label,
        "has_autofeat":        has_autofeat,
        "added_features":      added_features,
        "original_filename":   feat_json.get("original_filename", ""),
        "model_name_from_data": feat_json.get("model_name", ""),
        "csv_enriched":        False,
    }

    # Leaderboard
    try:
        lb = predictor.leaderboard(silent=True)
        m["leaderboard"] = lb.to_dict(orient="records")
    except Exception:
        m["leaderboard"] = []

    # Best model
    best = None
    try:
        best = predictor.get_model_best()
    except Exception:
        pass
    if not best and m["leaderboard"]:
        best = m["leaderboard"][0].get("model")
    m["best_model"] = best or "Unknown"

    # Feature importance
    try:
        fi = predictor.feature_importance(silent=True)
        fi_r = fi.reset_index()
        cols = fi_r.columns.tolist()
        rn   = {}
        if cols[0] != "feature":
            rn[cols[0]] = "feature"
        num_cols = [c for c in cols[1:] if pd.api.types.is_numeric_dtype(fi_r[c])]
        if num_cols and num_cols[0] != "importance":
            rn[num_cols[0]] = "importance"
        if rn:
            fi_r = fi_r.rename(columns=rn)
        m["feature_importance"] = fi_r.to_dict(orient="records")
    except Exception:
        m["feature_importance"] = []

    try:
        m["model_names"] = predictor.get_model_names()
    except Exception:
        m["model_names"] = []

    try:
        m["classes"] = list(predictor.class_labels) if predictor.class_labels else []
    except Exception:
        m["classes"] = []

    m["input_schema"]            = input_schema
    m["num_features_original"]   = len(input_schema)
    m["num_features_engineered"] = len(added_features)
    return m


# ── Session endpoints ─────────────────────────────────────────────────────────

@app.get("/api/session/{sid}")
def get_session(sid):
    if sid not in SESSIONS:
        raise HTTPException(404, "Session not found")
    SESSIONS[sid]["last_access"] = time.time()
    return {
        "metadata":        safe_json(SESSIONS[sid]["metadata"]),
        "deployment_name": SESSIONS[sid]["deployment_name"],
    }

@app.delete("/api/session/{sid}")
def del_session(sid):
    cleanup_session(sid)
    return {"status": "deleted"}


# ── Single predict ────────────────────────────────────────────────────────────

class PredictRequest(BaseModel):
    inputs:     dict[str, Any]
    model_name: Optional[str] = None

@app.post("/api/session/{sid}/predict")
def predict(sid: str, req: PredictRequest):
    if sid not in SESSIONS:
        raise HTTPException(404, "Session not found")
    sess = SESSIONS[sid]
    sess["last_access"] = time.time()

    schema = sess["metadata"]["input_schema"]
    row, filled = {}, []

    for feat in schema:
        name = feat["name"]
        val  = req.inputs.get(name)

        if val is not None and val != "":
            row[name] = coerce_value(val, feat)
        else:
            # Auto-fill with median > mode > first option
            fb = feat.get("median") if feat.get("median") is not None else feat.get("mode")
            if fb is None and feat.get("options"):
                opt = feat["options"][0]
                fb  = opt if isinstance(opt, str) else opt.get("value")
            row[name] = coerce_value(fb, feat) if fb is not None else fb
            filled.append(name)

    df = pd.DataFrame([row])
    df = apply_feature_engineering(df, sess["autofeat"], sess.get("added_features", {}))

    predictor = sess["predictor"]
    try:
        model_arg = (req.model_name
                     if req.model_name and
                        req.model_name in (sess["metadata"].get("model_names") or [])
                     else None)
        pred   = predictor.predict(df, model=model_arg) if model_arg \
                 else predictor.predict(df)
        result = safe_json(pred.iloc[0])

        proba = {}
        try:
            proba = safe_json(predictor.predict_proba(df).iloc[0].to_dict())
        except Exception:
            pass

        return {"prediction": result, "probabilities": proba, "auto_filled": filled}

    except Exception as e:
        # Return the full traceback so user can debug
        raise HTTPException(500,
            f"Prediction failed: {e}\n\n{traceback.format_exc()}")


# ── Batch predict ─────────────────────────────────────────────────────────────

@app.post("/api/session/{sid}/predict-batch")
async def predict_batch(sid: str, file: UploadFile = File(...)):
    if sid not in SESSIONS:
        raise HTTPException(404, "Session not found")
    sess = SESSIONS[sid]
    sess["last_access"] = time.time()

    content = await file.read()
    try:
        df_input = pd.read_csv(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(400, f"Cannot parse CSV file: {e}. Make sure the file is a valid .csv")

    df_input    = sanitize_df(df_input)
    schema      = sess["metadata"]["input_schema"]
    schema_cols = [f["name"] for f in schema]

    # ── Schema validation: reject wrong-dataset files ──────────────────────
    chk = _validate_csv_schema(df_input, schema, context="batch prediction")
    if not chk["valid"]:
        raise HTTPException(400, chk["error"])

    _schema_warning = chk.get("warning")
    available       = [c for c in schema_cols if c in df_input.columns]
    if not available:
        raise HTTPException(400,
            f"No matching feature columns found. "
            f"Model expects: {schema_cols[:5]}, CSV has: {df_input.columns.tolist()[:5]}")

    df_model = df_input[available].copy()

    # Fill missing schema columns with defaults
    for feat in schema:
        col = feat["name"]
        if col not in df_model.columns:
            df_model[col] = coerce_value(
                feat.get("median") or feat.get("mode") or 0, feat)

    df_model = df_model[schema_cols]
    df_model = apply_feature_engineering(df_model, sess["autofeat"], sess.get("added_features", {}))

    predictor = sess["predictor"]
    try:
        preds = predictor.predict(df_model)
        # Keep original (unsanitized) output columns for user readability
        df_out               = df_input.copy()
        df_out["prediction"] = preds.values
        try:
            proba = predictor.predict_proba(df_model)
            for c in proba.columns:
                df_out[f"prob_{c}"] = proba[c].values
            df_out["confidence"] = proba.max(axis=1).values
        except Exception:
            pass

        buf = io.StringIO()
        df_out.to_csv(buf, index=False)
        buf.seek(0)
        return StreamingResponse(
            io.BytesIO(buf.read().encode()),
            media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=predictions.csv"})

    except Exception as e:
        raise HTTPException(500, f"Batch prediction failed: {e}\n\n{traceback.format_exc()}")


# ── Test Model ────────────────────────────────────────────────────────────────

@app.post("/api/session/{sid}/test-model")
async def test_model(sid: str, file: UploadFile = File(...)):
    """
    Upload a CSV with the target column (true labels) to evaluate model performance.
    Returns full metrics + visualization data (scatter / confusion matrix).
    """
    if sid not in SESSIONS:
        raise HTTPException(404, "Session not found")
    sess = SESSIONS[sid]
    sess["last_access"] = time.time()

    content = await file.read()
    try:
        df_raw = pd.read_csv(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(400, f"Cannot parse CSV file: {e}. Make sure the file is a valid .csv")

    df_raw       = sanitize_df(df_raw)
    target_col   = sess["target_col"]
    schema       = sess["metadata"]["input_schema"]
    schema_cols  = [f["name"] for f in schema]
    predictor    = sess["predictor"]
    problem_type = sess["metadata"]["problem_type"]

    # Validate schema — exclude target col from check (it's expected to be present here)
    _feat_df = df_raw[[c for c in df_raw.columns if c != target_col]]
    chk_tm   = _validate_csv_schema(_feat_df, schema, context="model testing")
    if not chk_tm["valid"]:
        raise HTTPException(400, chk_tm["error"])

    if target_col not in df_raw.columns:
        raise HTTPException(400,
            f"Target column '{target_col}' not found. "
            f"Available: {df_raw.columns.tolist()[:10]}")

    actuals = df_raw[target_col].copy().reset_index(drop=True)

    available = [c for c in schema_cols if c in df_raw.columns]
    if not available:
        raise HTTPException(400,
            f"No matching feature columns. Expected: {schema_cols[:5]}")

    df_model = df_raw[available].copy()
    for feat in schema:
        col = feat["name"]
        if col not in df_model.columns:
            df_model[col] = coerce_value(feat.get("median") or feat.get("mode") or 0, feat)
    df_model = df_model[schema_cols]
    df_model = apply_feature_engineering(df_model, sess["autofeat"], sess.get("added_features", {}))

    try:
        preds = predictor.predict(df_model).reset_index(drop=True)
    except Exception as e:
        raise HTTPException(500, f"Prediction failed: {e}\n{traceback.format_exc()}")

    n      = len(actuals)
    result: dict = {"n_samples": n, "problem_type": problem_type}

    import random as _rnd
    sample_idx = sorted(_rnd.sample(range(n), min(300, n)))
    result["sample_actuals"]     = safe_json(actuals.iloc[sample_idx].tolist())
    result["sample_predictions"] = safe_json(preds.iloc[sample_idx].tolist())

    try:
        from sklearn import metrics as skm

        if problem_type == "regression":
            y_true = pd.to_numeric(actuals, errors="coerce")
            y_pred = pd.to_numeric(preds,   errors="coerce")
            valid  = y_true.notna() & y_pred.notna()
            yt, yp = y_true[valid], y_pred[valid]
            rmse = float(np.sqrt(skm.mean_squared_error(yt, yp)))
            mae  = float(skm.mean_absolute_error(yt, yp))
            r2   = float(skm.r2_score(yt, yp))
            mape = None
            nz   = yt[yt != 0]
            if len(nz) > 0:
                mape = float(np.mean(np.abs((nz - yp[nz.index]) / nz)) * 100)
            result["metrics"] = {
                "RMSE":     round(rmse, 4),
                "MAE":      round(mae,  4),
                "R²":  round(r2,   4),
                "MAPE (%)": round(mape, 2) if mape is not None and np.isfinite(mape) else None,
            }
            result["scatter"] = safe_json([
                {"actual": float(yt.iloc[i]), "predicted": float(yp.iloc[i])}
                for i in range(min(300, len(yt)))
            ])

        elif problem_type in ("binary", "multiclass"):
            acc  = float(skm.accuracy_score(actuals, preds))
            f1_w = float(skm.f1_score(actuals, preds, average="weighted", zero_division=0))
            prec = float(skm.precision_score(actuals, preds, average="weighted", zero_division=0))
            rec  = float(skm.recall_score(actuals, preds, average="weighted", zero_division=0))
            result["metrics"] = {
                "Accuracy":    round(acc,  4),
                "Weighted F1": round(f1_w, 4),
                "Precision":   round(prec, 4),
                "Recall":      round(rec,  4),
            }
            if problem_type == "binary":
                try:
                    proba_df  = predictor.predict_proba(df_model)
                    pos_class = predictor.class_labels[-1]
                    auc = float(skm.roc_auc_score(actuals, proba_df[pos_class]))
                    result["metrics"]["ROC-AUC"] = round(auc, 4)
                except Exception:
                    pass
            labels = sorted(set(actuals.unique().tolist()))
            cm     = skm.confusion_matrix(actuals, preds, labels=labels)
            result["confusion_matrix"] = {
                "matrix": cm.tolist(),
                "labels": [str(l) for l in labels],
            }
            try:
                report = skm.classification_report(actuals, preds,
                             output_dict=True, zero_division=0)
                result["per_class"] = {
                    k: {m: round(float(v), 4)
                        for m, v in vd.items()
                        if m in ("precision", "recall", "f1-score")}
                    for k, vd in report.items()
                    if k not in ("accuracy", "macro avg", "weighted avg")
                    and isinstance(vd, dict)
                }
            except Exception:
                pass

    except ImportError:
        result["metrics"] = {"error": "scikit-learn not installed"}
    except Exception as e:
        result["metrics"] = {"error": str(e)}

    return result



# ── What-If ───────────────────────────────────────────────────────────────────

class WhatIfRequest(BaseModel):
    base_inputs:  dict[str, Any]
    vary_feature: str
    range_values: list[Any]

@app.post("/api/session/{sid}/whatif")
def whatif(sid: str, req: WhatIfRequest):
    if sid not in SESSIONS:
        raise HTTPException(404, "Session not found")
    sess = SESSIONS[sid]
    sess["last_access"] = time.time()

    schema    = sess["metadata"]["input_schema"]
    predictor = sess["predictor"]
    autofeat  = sess["autofeat"]    # Build base row with defaults
    base = {}
    for feat in schema:
        n   = feat["name"]
        val = req.base_inputs.get(n)
        if val is not None and val != "":
            base[n] = coerce_value(val, feat)
        else:
            fb     = feat.get("median") if feat.get("median") is not None else feat.get("mode")
            base[n] = coerce_value(fb, feat) if fb is not None else 0

    results = []
    for val in req.range_values:
        row = {**base, req.vary_feature: coerce_value(val, next(
            (f for f in schema if f["name"] == req.vary_feature), {}))}
        df  = pd.DataFrame([row])
        df  = apply_feature_engineering(df, autofeat, sess.get("added_features", {}))
        try:
            pred  = predictor.predict(df).iloc[0]
            proba = {}
            try:
                proba = predictor.predict_proba(df).iloc[0].to_dict()
            except Exception:
                pass
            conf = max(proba.values()) if proba else None
            results.append({
                "value":         safe_json(val),
                "prediction":    safe_json(pred),
                "confidence":    safe_json(conf),
                "probabilities": safe_json(proba),
            })
        except Exception:
            results.append({"value": safe_json(val),
                            "prediction": None, "confidence": None})

    return {"results": results}




# ── Export deployment package ─────────────────────────────────────────────────────────────────


# ── Smart requirements generator ─────────────────────────────────────────────

def _smart_requirements(ag_dir: str) -> str:
    """
    Inspect the AutoGluon model directory and generate a requirements.txt
    that only includes packages for models that are actually present.
    Prevents 'torch not installed', 'lightgbm not installed' errors on
    deployment targets that don't have optional packages.
    """
    # Base packages always needed
    # autogluon.tabular[all] installs ALL optional model backends:
    # lightgbm, xgboost, catboost, torch, fastai — eliminates missing-package errors
    base = [
        "fastapi",
        "uvicorn[standard]",
        "python-multipart",
        "pandas",
        "numpy",
        "scikit-learn",
        "autofeat",
        "autogluon.tabular[all]",
    ]

    # Model type → pip package(s) needed
    MODEL_PKG_MAP = {
        "lightgbm":      ["lightgbm"],
        "xgboost":       ["xgboost"],
        "catboost":      ["catboost"],
        "neuralnettorch": ["torch"],
        "torch":         ["torch"],
        "fastai":        ["fastai"],
        "neuralnetfastai": ["fastai"],
        "vowpalwabbit":  ["vowpalwabbit"],
    }

    extra = set()

    if ag_dir and os.path.isdir(ag_dir):
        # Walk all files — look for model_metadata.json or trainer_metadata.json
        # and also just check subfolder names (AutoGluon names folders after model type)
        for root, dirs, files in os.walk(ag_dir):
            folder_lower = os.path.basename(root).lower()
            for key, pkgs in MODEL_PKG_MAP.items():
                if key in folder_lower:
                    extra.update(pkgs)

            for fname in files:
                if fname in ("model_metadata.json", "trainer_metadata.json", "hyperparameters.json"):
                    try:
                        with open(os.path.join(root, fname)) as f:
                            data = json.load(f)
                        text = json.dumps(data).lower()
                        for key, pkgs in MODEL_PKG_MAP.items():
                            if key in text:
                                extra.update(pkgs)
                    except Exception:
                        pass

                # Check pickle/model files by name
                if fname.endswith(('.pkl', '.bin', '.pt', '.pth')):
                    name_lower = fname.lower()
                    for key, pkgs in MODEL_PKG_MAP.items():
                        if key in name_lower:
                            extra.update(pkgs)

    all_pkgs = base + sorted(extra)
    return "\n".join(all_pkgs) + "\n"


@app.get("/api/session/{sid}/export")
def export_deployment(sid: str):
    if sid not in SESSIONS:
        raise HTTPException(404, "Session not found")
    sess     = SESSIONS[sid]
    name     = sess["deployment_name"].replace(" ", "_").lower()
    meta     = sess.get("metadata", {})
    schema   = meta.get("input_schema", [])
    temp_dir = sess.get("temp_dir", "")

    # Schema JSON — everything the standalone app needs to run
    schema_data = {
        "model_name":         sess.get("deployment_name", name),
        "problem_type":       meta.get("problem_type"),
        "eval_metric":        str(meta.get("eval_metric", "")),
        "best_model":         meta.get("best_model", "Unknown"),
        "label":              meta.get("label"),
        "classes":            meta.get("classes", []),
        "input_schema":       schema,
        "added_features":     meta.get("added_features", {}),
        "feature_importance": meta.get("feature_importance", []),
        "leaderboard":        meta.get("leaderboard", []),
        "num_features":       len(schema),
        "n_models":           len(meta.get("leaderboard", [])),
    }

    # Compute ag_dir early for smart requirements
    _early_extract = os.path.join(temp_dir, "ext") if temp_dir else ""
    _early_ag_dir  = find_autogluon_dir(_early_extract) if _early_extract and os.path.exists(_early_extract) else ""

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # ── Core server files
        zf.writestr("app.py",             _APP_PY)
        zf.writestr("requirements.txt",   _smart_requirements(_early_ag_dir))
        zf.writestr("Dockerfile",         _DOCKERFILE)
        zf.writestr("docker-compose.yml", _DOCKER_COMPOSE.format(name=name))
        zf.writestr("render.yaml",        _RENDER_YAML.format(name=name))
        zf.writestr("fly.toml",           _FLY_TOML.format(name=name))
        zf.writestr("railway.json",       _RAILWAY_JSON)
        zf.writestr("openapi.json",       _build_openapi_json(name, meta, schema))

        # ── Baked schema metadata
        zf.writestr("schema.json", json.dumps(schema_data, indent=2, default=str))

        # ── Standalone frontend app
        zf.writestr("frontend/index.html", _build_deployment_html(sess))

        # ── Bundle actual model artifacts from the uploaded ZIP
        extract_dir = os.path.join(temp_dir, "ext") if temp_dir else ""
        if extract_dir and os.path.exists(extract_dir):
            ag_dir = find_autogluon_dir(extract_dir)
            if ag_dir:
                for root, _dirs, files in os.walk(ag_dir):
                    for fname in files:
                        abs_p = os.path.join(root, fname)
                        rel   = os.path.relpath(abs_p, ag_dir)
                        zf.write(abs_p, f"autogluon_model/{rel}")

            af_path = find_file(extract_dir, ["autofeat"])
            if af_path:
                zf.write(af_path, "autofeat_model.pkl")

            fj_path = find_file(extract_dir, ["feature_engineering","features_eng","features.json"])
            if fj_path:
                zf.write(fj_path, "features_eng.json")

        # ── Full README
        zf.writestr("README.md", _build_readme(name, sess))

    buf.seek(0)
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={name}_deployment.zip"})



_APP_PY = '''import json, os, io, pickle, re, traceback
import pandas as pd
import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel
from typing import Any
from autogluon.tabular import TabularPredictor

app = FastAPI(title="Deploy Alchemy Model API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Load everything at startup ────────────────────────────────────────────────
with open("schema.json") as _f:
    _SCHEMA_DATA = json.load(_f)

_predictor = TabularPredictor.load(
    os.getenv("MODEL_DIR", "./autogluon_model"),
    require_py_version_match=False,
)

_autofeat = None
for _fname in ["autofeat_model.pkl", "autofeat.pkl"]:
    if os.path.exists(_fname):
        with open(_fname, "rb") as _f:
            _autofeat = pickle.load(_f)
        break

_SCHEMA    = _SCHEMA_DATA.get("input_schema", [])
_ADDED_FTS = _SCHEMA_DATA.get("added_features", {}) or {}

# ── Helpers ───────────────────────────────────────────────────────────────────
def _sanitize(name: str) -> str:
    name = str(name).strip()
    name = re.sub(r"[\s\-]+", "_", name)
    name = re.sub(r"[^\w]", "", name)
    name = re.sub(r"_+", "_", name)
    return name.strip("_")

def _coerce(val, feat: dict):
    if val is None: return val
    dtype = str(feat.get("dtype", ""))
    if any(t in dtype for t in ("int", "float", "category")):
        try:
            f = float(str(val).strip())
            return int(f) if "float" not in dtype else f
        except Exception: pass
    return val

def _apply_features(df: pd.DataFrame) -> pd.DataFrame:
    if _autofeat is not None:
        try: df = _autofeat.transform(df.copy())
        except Exception: pass
    for col, formula in _ADDED_FTS.items():
        if col not in df.columns:
            try:   df[col] = df.eval(formula)
            except Exception: df[col] = 0
    return df

def _safe_json(obj):
    if isinstance(obj, (np.integer,)):  return int(obj)
    if isinstance(obj, (np.floating,)): return float(obj)
    if isinstance(obj, np.ndarray):     return obj.tolist()
    if isinstance(obj, dict):           return {k: _safe_json(v) for k, v in obj.items()}
    if isinstance(obj, list):           return [_safe_json(i) for i in obj]
    return obj

# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
def root():
    p = os.path.join("frontend", "index.html")
    return open(p, encoding="utf-8").read() if os.path.exists(p) else (
        "<h1>Deploy Alchemy Model API</h1><p>Open <a href=\'/docs\'>/docs</a></p>")

@app.post("/test-model")
async def test_model_eval(file: UploadFile = File(...)):
    content = await file.read()
    try:    df_raw = pd.read_csv(io.BytesIO(content))
    except Exception as e: raise HTTPException(400, f"Cannot read CSV: {e}")
    df_raw.columns = [_sanitize(c) for c in df_raw.columns]
    target_col   = _SCHEMA_DATA.get("label", "target")
    problem_type = _SCHEMA_DATA.get("problem_type", "regression")
    schema_cols  = [f["name"] for f in _SCHEMA]
    if target_col not in df_raw.columns:
        raise HTTPException(400, f"Target column '{target_col}' not found. Columns: {df_raw.columns.tolist()[:10]}")
    actuals  = df_raw[target_col].copy().reset_index(drop=True)
    df_feat  = df_raw.drop(columns=[target_col], errors="ignore").copy()
    for feat in _SCHEMA:
        col = feat["name"]
        if col not in df_feat.columns:
            df_feat[col] = _coerce(feat.get("median") or feat.get("mode") or 0, feat)
    avail = [c for c in schema_cols if c in df_feat.columns]
    if not avail: raise HTTPException(400, "No matching feature columns found.")
    df_feat = df_feat[avail]
    df_feat = _apply_features(df_feat)
    try:    preds = _predictor.predict(df_feat).reset_index(drop=True)
    except Exception as e: raise HTTPException(500, f"Prediction failed: {e}")
    n = len(actuals); result = {"n_samples": n, "problem_type": problem_type}
    try:
        from sklearn import metrics as skm; import random as _r
        if problem_type == "regression":
            yt = pd.to_numeric(actuals, errors="coerce")
            yp = pd.to_numeric(preds,   errors="coerce")
            m  = yt.notna() & yp.notna(); yt, yp = yt[m], yp[m]
            rmse = float(np.sqrt(skm.mean_squared_error(yt, yp)))
            mae  = float(skm.mean_absolute_error(yt, yp))
            r2   = float(skm.r2_score(yt, yp))
            nz   = yt[yt != 0]
            mape = float(np.mean(np.abs((nz.values - yp[nz.index].values) / nz.values)) * 100) if len(nz) else None
            result["metrics"] = {"RMSE": round(rmse,4), "MAE": round(mae,4),
                "R\u00b2": round(r2,4),
                "MAPE (%)": round(mape,2) if mape and np.isfinite(mape) else None}
            idx = sorted(_r.sample(range(len(yt)), min(300, len(yt))))
            result["scatter"] = _safe_json([{"actual": float(yt.iloc[i]), "predicted": float(yp.iloc[i])} for i in idx])
        else:
            acc  = float(skm.accuracy_score(actuals, preds))
            f1   = float(skm.f1_score(actuals, preds, average="weighted", zero_division=0))
            prec = float(skm.precision_score(actuals, preds, average="weighted", zero_division=0))
            rec  = float(skm.recall_score(actuals, preds, average="weighted", zero_division=0))
            result["metrics"] = {"Accuracy": round(acc,4), "Weighted F1": round(f1,4),
                "Precision": round(prec,4), "Recall": round(rec,4)}
            try:
                proba = _predictor.predict_proba(df_feat)
                auc   = float(skm.roc_auc_score(actuals, proba[_predictor.class_labels[-1]]))
                result["metrics"]["ROC-AUC"] = round(auc, 4)
            except: pass
            lbls = sorted(set(actuals.unique().tolist()))
            cm   = skm.confusion_matrix(actuals, preds, labels=lbls)
            result["confusion_matrix"] = {"matrix": cm.tolist(), "labels": [str(l) for l in lbls]}
            try:
                rpt = skm.classification_report(actuals, preds, output_dict=True, zero_division=0)
                result["per_class"] = {
                    k: {m: round(float(v), 4) for m, v in vd.items() if m in ("precision","recall","f1-score")}
                    for k, vd in rpt.items()
                    if k not in ("accuracy","macro avg","weighted avg") and isinstance(vd, dict)
                }
            except: pass
    except Exception as e:
        result["metrics"] = {"error": str(e)}
    return result


@app.get("/health")
def health():
    return {"status": "ok", "model": _SCHEMA_DATA.get("model_name", "unknown")}

@app.get("/model-info")
def model_info():
    return _SCHEMA_DATA

class PredictRequest(BaseModel):
    inputs: dict[str, Any]

@app.post("/predict")
def predict(req: PredictRequest):
    row = {}
    for feat in _SCHEMA:
        name = feat["name"]
        val  = req.inputs.get(name)
        if val is not None and str(val) != "":
            row[name] = _coerce(val, feat)
        else:
            fb = feat.get("median") if feat.get("median") is not None else feat.get("mode")
            row[name] = _coerce(fb, feat) if fb is not None else fb
    df   = pd.DataFrame([row])
    df   = _apply_features(df)
    pred = _predictor.predict(df)
    r    = {"prediction": _safe_json(pred.iloc[0])}
    try:
        proba = _predictor.predict_proba(df).iloc[0].to_dict()
        r["probabilities"] = _safe_json(proba)
        r["confidence"]    = float(max(proba.values()))
    except Exception: pass
    return r



def _validate_csv_schema(df, schema, context="batch"):
    if not schema:
        return {"valid": True, "error": None, "warning": None, "match_pct": 1.0}
    schema_set = set(f["name"] for f in schema)
    upload_set = set(df.columns.tolist())
    matched    = schema_set & upload_set
    missing    = schema_set - upload_set
    extra      = upload_set - schema_set
    n          = len(schema_set)
    pct        = len(matched) / n if n else 1.0
    if pct == 0:
        return {"valid": False, "error":
            f"❌ Wrong file — no matching columns found."
            f"Model expects: {', '.join(sorted(schema_set)[:5])}"
            f"Your file has: {', '.join(sorted(extra)[:5])}"
            f"Please upload the correct original CSV file.", "warning": None, "match_pct": 0}
    if pct < 0.10:
        return {"valid": False, "error":
            f"❌ Wrong CSV — only {int(pct*100)}% of columns matched ({len(matched)}/{n})."
            f"Matched: {', '.join(sorted(matched)[:3])}"
            f"Expected: {', '.join(sorted(missing)[:4])}"
            f"Please upload the original training data CSV.", "warning": None, "match_pct": round(pct,3)}
    if pct < 0.40:
        return {"valid": False, "error":
            f"❌ Possibly wrong CSV — only {int(pct*100)}% column match ({len(matched)}/{n})."
            f"Found: {', '.join(sorted(matched)[:4])}"
            f"Missing: {', '.join(sorted(missing)[:4])}"
            f"Upload the original training CSV or check column names.", "warning": None, "match_pct": round(pct,3)}
    warn = (f"⚠️ {len(missing)} column(s) auto-filled with training defaults: {', '.join(sorted(missing)[:4])}"
            + (" ..." if len(missing) > 4 else "")) if missing else None
    return {"valid": True, "error": None, "warning": warn, "match_pct": round(pct,3),
            "matched": sorted(matched), "missing": sorted(missing)}

@app.post("/predict-batch")
async def predict_batch(file: UploadFile = File(...)):
    content = await file.read()
    try:    df_in = pd.read_csv(io.BytesIO(content))
    except Exception as e: raise HTTPException(400, f"Cannot read CSV: {e}")
    df_in.columns = [_sanitize(c) for c in df_in.columns]
    schema_cols   = [f["name"] for f in _SCHEMA]
    chk = _validate_csv_schema(df_in, _SCHEMA, "batch prediction")
    if not chk["valid"]:
        raise HTTPException(400, chk["error"])
    df_model      = pd.DataFrame()
    for feat in _SCHEMA:
        col = feat["name"]
        df_model[col] = df_in[col] if col in df_in.columns else _coerce(
            feat.get("median") or feat.get("mode") or 0, feat)
    df_model = df_model[schema_cols]
    df_model = _apply_features(df_model)
    preds              = _predictor.predict(df_model)
    df_out             = df_in.copy()
    df_out["prediction"] = preds.values
    try:
        proba = _predictor.predict_proba(df_model)
        for c in proba.columns: df_out[f"prob_{c}"] = proba[c].values
        df_out["confidence"] = proba.max(axis=1).values
    except Exception: pass
    buf = io.StringIO()
    df_out.to_csv(buf, index=False); buf.seek(0)
    return StreamingResponse(
        io.BytesIO(buf.read().encode()), media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=predictions.csv"})
'''


_REQUIREMENTS = (
    "fastapi\nuvicorn[standard]\n"
    "python-multipart\npandas\nnumpy\nscikit-learn\n"
    "autofeat\nautogluon.tabular[all]\n"
)
_DOCKERFILE = (
    "FROM python:3.10-slim\nWORKDIR /app\n"
    "RUN apt-get update && apt-get install -y gcc g++ libgomp1 "
    "&& rm -rf /var/lib/apt/lists/*\n"
    "COPY requirements.txt .\n"
    "RUN pip install --no-cache-dir -r requirements.txt\n"
    "COPY . .\nEXPOSE 8000\n"
    'CMD ["uvicorn","app:app","--host","0.0.0.0","--port","8000"]\n'
)


_DOCKER_COMPOSE = (
    "version: '3.8'\n"
    "services:\n"
    "  app:\n"
    "    build: .\n"
    "    ports:\n"
    "      - \"8000:8000\"\n"
    "    volumes:\n"
    "      - ./autogluon_model:/app/autogluon_model\n"
    "    environment:\n"
    "      - MODEL_DIR=/app/autogluon_model\n"
    "      - PYTHONUNBUFFERED=1\n"
    "    restart: unless-stopped\n"
)

_RENDER_YAML = (
    "services:\n"
    "  - type: web\n"
    "    name: {name}\n"
    "    env: docker\n"
    "    plan: free\n"
    "    healthCheckPath: /health\n"
)

_FLY_TOML = (
    "app = \"{name}\"\n"
    "primary_region = \"lax\"\n\n"
    "[build]\n\n"
    "[[services]]\n"
    "  internal_port = 8000\n"
    "  protocol = \"tcp\"\n"
    "  [[services.ports]]\n"
    "    handlers = [\"http\"]\n"
    "    port = 80\n"
    "  [[services.ports]]\n"
    "    handlers = [\"tls\", \"http\"]\n"
    "    port = 443\n"
)

_RAILWAY_JSON = (
    '{"build":{"builder":"DOCKERFILE"},'
    ' "deploy":{"startCommand":"uvicorn app:app --host 0.0.0.0 --port $PORT",'
    ' "healthcheckPath":"/health"}}'
)


def _build_openapi_json(name, meta, schema):
    props = {}
    for f in schema:
        t = "number" if any(x in str(f.get("dtype","")) for x in ["int","float"]) else "string"
        props[f["name"]] = {"type": t}
    spec = {
        "openapi": "3.0.0",
        "info": {"title": name, "version": "1.0.0",
                  "description": f"Task: {meta.get('problem_type','?')}  Metric: {meta.get('eval_metric','?')}"},
        "paths": {
            "/health": {"get": {"summary": "Health check",
                                 "responses": {"200": {"description": "ok"}}}},
            "/model-info": {"get": {"summary": "Model metadata",
                                      "responses": {"200": {"description": "metadata"}}}},
            "/predict": {"post": {
                "summary": "Predict",
                "requestBody": {"required": True, "content": {
                    "application/json": {"schema": {"type": "object",
                        "properties": {"inputs": {"type": "object", "properties": props}},
                        "required": ["inputs"]}}}},
                "responses": {"200": {"description": "Prediction result"}}}},
        }
    }
    return json.dumps(spec, indent=2)



def _build_readme(name: str, sess: dict) -> str:
    meta = sess.get("metadata", {})
    schema = meta.get("input_schema", [])
    title  = name.replace("_", " ").title()
    sample = ", ".join(f'"{f["name"]}": ...' for f in schema[:3])
    lb_rows = ""
    for i, m in enumerate((meta.get("leaderboard") or [])[:5]):
        score = m.get("score_val") or m.get("score") or 0
        lb_rows += f"| {'🥇🥈🥉'[i] if i < 3 else f'#{i+1}'} | {m.get('model','?')} | {score:.4f} |\n"
    return f"""# {title} — Deploy Alchemy Deployment

> Auto-generated by [Deploy Alchemy](https://github.com/your-org/deploy-alchemy)

## 🚀 Quick Start (local)

```bash
# 1 – Install dependencies (Python 3.10+)
pip install -r requirements.txt

# 2 – Start the server
uvicorn app:app --host 0.0.0.0 --port 8000 --reload

# 3 – Open the browser UI
open http://localhost:8000
```

The welcome screen, prediction form, and batch uploader are served at **http://localhost:8000**.

---

## 📦 What's in this package

| File | Purpose |
|---|---|
| `app.py` | FastAPI backend (serves API + frontend) |
| `requirements.txt` | Python dependencies |
| `schema.json` | Model metadata + feature schema |
| `autogluon_model/` | Trained AutoGluon model artifacts |
| `autofeat_model.pkl` | Feature engineering pipeline (if used) |
| `features_eng.json` | Engineered feature definitions (if used) |
| `frontend/index.html` | Standalone prediction UI |
| `Dockerfile` | Container definition |
| `docker-compose.yml` | Local Docker setup |
| `render.yaml` | One-click Render.com deploy |
| `fly.toml` | Fly.io configuration |
| `railway.json` | Railway auto-deploy |
| `openapi.json` | Full OpenAPI 3.0 spec |

---

## 🐳 Docker

```bash
docker build -t {name} .
docker run -p 8000:8000 {name}
```

## ☁️ Cloud Deployment

### Railway (recommended)
1. Push this folder to a GitHub repository
2. Import the repo at [railway.app](https://railway.app)
3. Railway auto-detects `railway.json` — deploy in one click

### Render
1. Push to GitHub
2. Create a new "Web Service" at [render.com](https://render.com)
3. Select "Use existing `render.yaml`"

### Fly.io
```bash
flyctl launch
flyctl deploy
```

---

## 🔌 API Reference

### `GET /health`
Returns server liveness status.

### `GET /model-info`
Returns model metadata, feature schema, and leaderboard.

### `POST /predict`
Run a single prediction.

**Request:**
```json
{{"inputs": {{{sample}}}}}
```

**Response:**
```json
{{"prediction": ..., "probabilities": {{}}, "confidence": 0.95}}
```

### `POST /predict-batch`
Upload a CSV file to get batch predictions.  
Returns a CSV with `prediction`, `confidence`, and `prob_*` columns appended.

---

## 📊 Model Info

| Property | Value |
|---|---|
| Task type | `{meta.get("problem_type", "?")}` |
| Eval metric | `{meta.get("eval_metric", "?")}` |
| Best model | `{meta.get("best_model", "?")}` |
| Input features | {len(schema)} |
| Target column | `{meta.get("label", "?")}` |

### Top Models
| Rank | Model | Val Score |
|---|---|---|
{lb_rows}
---

*Generated by Deploy Alchemy — https://github.com/your-org/deploy-alchemy*
"""


_DEPLOY_HTML_TEMPLATE = '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>%%MODEL_TITLE%% — Deploy Alchemy</title>\n  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&family=Outfit:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">\n  <style>\n    :root{--void:#050810;--surface:#0d1628;--card:#111d35;--border:#1a2d50;--glow:#00f5ff;}\n    *{box-sizing:border-box;margin:0;padding:0;}\n    html,body{min-height:100%;background:var(--void);color:#e2e8f0;font-family:Outfit,sans-serif;overflow-x:hidden;}\n    #bg{position:fixed;inset:0;pointer-events:none;z-index:0;}\n    #app{position:relative;z-index:1;max-width:1100px;margin:0 auto;padding:24px 16px 48px;}\n    .glass{background:rgba(17,29,53,.85);backdrop-filter:blur(20px);border:1px solid rgba(26,45,80,.7);border-radius:12px;}\n    .hdr{padding:18px 24px 0;margin-bottom:20px;}\n    .hdr-top{display:flex;align-items:center;gap:14px;}\n    .logo{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,rgba(0,245,255,.2),rgba(124,58,237,.2));border:1px solid rgba(0,245,255,.3);display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0;}\n    .model-title{font-family:Cinzel,serif;font-size:1.4rem;font-weight:700;background:linear-gradient(135deg,#00f5ff,#7c3aed,#f97316);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}\n    .badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px;}\n    .badge{border-radius:4px;padding:2px 8px;font-family:\'JetBrains Mono\',monospace;font-size:11px;border:1px solid;}\n    .badge-c{background:rgba(0,245,255,.08);color:#67e8f9;border-color:rgba(0,245,255,.2);}\n    .badge-p{background:rgba(124,58,237,.08);color:#c4b5fd;border-color:rgba(124,58,237,.2);}\n    .badge-s{background:rgba(100,116,139,.08);color:#94a3b8;border-color:rgba(100,116,139,.2);}\n    .status{width:8px;height:8px;border-radius:50%;background:#334155;margin-left:auto;}\n    .status.on{background:#10b981;box-shadow:0 0 8px rgba(16,185,129,.7);}\n    .nav{display:flex;gap:2px;margin-top:14px;border-top:1px solid var(--border);padding-top:12px;}\n    .nb{display:flex;align-items:center;gap:6px;padding:8px 16px;border:none;background:none;color:#64748b;font-family:Outfit,sans-serif;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;transition:all .2s;}\n    .nb:hover{color:#cbd5e1;} .nb.active{color:#67e8f9;border-bottom-color:#00f5ff;}\n    .panel{display:none;margin-top:20px;} .panel.active{display:block;}\n    .sg{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:10px;}\n    .sc{padding:13px;border-radius:12px;}\n    .sl{font-family:\'JetBrains Mono\',monospace;font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px;}\n    .sv{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}\n    .sec{padding:20px;} .sh{display:flex;align-items:center;gap:9px;margin-bottom:14px;}\n    .st{font-size:14px;font-weight:600;color:#e2e8f0;} .ss{font-family:\'JetBrains Mono\',monospace;font-size:10px;color:#475569;margin-top:1px;}\n    .lb-row{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;margin-bottom:4px;}\n    .lb-row:nth-child(1){background:rgba(0,245,255,.07);border:1px solid rgba(0,245,255,.15);}\n    .lb-row:nth-child(2){background:rgba(124,58,237,.05);border:1px solid rgba(124,58,237,.1);}\n    .lb-row:nth-child(3){background:rgba(249,115,22,.05);border:1px solid rgba(249,115,22,.1);}\n    .lb-row:nth-child(n+4){background:rgba(13,22,40,.5);border:1px solid rgba(26,45,80,.3);}\n    .fi-row{display:flex;align-items:center;gap:10px;margin-bottom:7px;}\n    .fi-n{font-family:\'JetBrains Mono\',monospace;font-size:11px;color:#64748b;width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}\n    .fi-t{flex:1;height:6px;background:#1a2d50;border-radius:3px;overflow:hidden;}\n    .fi-f{height:6px;border-radius:3px;}\n    .fi-v{font-family:\'JetBrains Mono\',monospace;font-size:10px;color:#475569;width:52px;text-align:right;}\n    .tbl{width:100%;border-collapse:collapse;font-size:11px;font-family:\'JetBrains Mono\',monospace;}\n    .tbl th{padding:7px 10px;text-align:left;color:#475569;border-bottom:1px solid var(--border);background:rgba(13,22,40,.6);}\n    .tbl td{padding:6px 10px;border-bottom:1px solid rgba(26,45,80,.3);color:#94a3b8;}\n    .fg{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;}\n    .fl{font-family:\'JetBrains Mono\',monospace;font-size:11px;color:#64748b;margin-bottom:5px;display:block;}\n    .fi{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 11px;color:#e2e8f0;font-family:Outfit,sans-serif;font-size:13px;outline:none;width:100%;transition:border-color .2s;}\n    .fi:focus{border-color:rgba(0,245,255,.5);}\n    .tw{display:flex;align-items:center;gap:8px;cursor:pointer;}\n    .tw input{display:none;}\n    .tt{width:38px;height:20px;background:#1a2d50;border-radius:10px;border:1px solid #2d4a7a;transition:all .3s;position:relative;}\n    .tt::after{content:\'\';position:absolute;top:2px;left:2px;width:14px;height:14px;background:#4a6a9a;border-radius:50%;transition:all .3s;}\n    .tw input:checked + .tt{background:rgba(0,245,255,.15);border-color:var(--glow);}\n    .tw input:checked + .tt::after{transform:translateX(18px);background:var(--glow);box-shadow:0 0 8px rgba(0,245,255,.5);}\n    .btn{width:100%;padding:13px;border-radius:12px;font-family:Outfit,sans-serif;font-weight:600;font-size:14px;cursor:pointer;border:1px solid rgba(0,245,255,.4);background:linear-gradient(135deg,rgba(0,245,255,.12),rgba(124,58,237,.12));color:#67e8f9;transition:all .3s;margin-top:18px;}\n    .btn:hover{background:linear-gradient(135deg,rgba(0,245,255,.2),rgba(124,58,237,.2));box-shadow:0 0 30px rgba(0,245,255,.2);}\n    .btn:disabled{background:var(--surface);border-color:var(--border);color:#334155;cursor:wait;}\n    .btnp{border-color:rgba(124,58,237,.4);background:linear-gradient(135deg,rgba(124,58,237,.12),rgba(0,245,255,.08));color:#c4b5fd;}\n    .btnp:hover{background:linear-gradient(135deg,rgba(124,58,237,.2),rgba(0,245,255,.12));}\n    .rv{font-family:Cinzel,serif;font-weight:700;color:#00f5ff;text-shadow:0 0 30px rgba(0,245,255,.5);text-align:center;padding:18px;background:rgba(0,245,255,.04);border-radius:8px;word-break:break-all;}\n    .pb-w{display:flex;align-items:center;gap:8px;margin-bottom:5px;}\n    .pb-t{flex:1;height:5px;background:#1a2d50;border-radius:3px;}\n    .pb-f{height:5px;border-radius:3px;transition:width .6s;}\n    .dz{border:2px dashed var(--border);border-radius:12px;padding:32px;text-align:center;cursor:pointer;transition:all .2s;}\n    .dz:hover,.dz.drag{border-color:rgba(0,245,255,.5);background:rgba(0,245,255,.03);}\n    .dzp:hover,.dzp.drag{border-color:rgba(124,58,237,.5);background:rgba(124,58,237,.03);}\n    .pt{height:4px;background:#1a2d50;border-radius:2px;margin-top:10px;overflow:hidden;}\n    .pf{height:4px;background:linear-gradient(90deg,#7c3aed,#00f5ff);border-radius:2px;width:0%;transition:width .3s;}\n    .subs{display:flex;gap:2px;margin-bottom:18px;background:rgba(13,22,40,.6);border-radius:10px;padding:3px;width:fit-content;}\n    .sb{padding:7px 16px;border-radius:8px;border:none;background:none;color:#475569;font-family:Outfit,sans-serif;font-size:12px;font-weight:500;cursor:pointer;transition:all .2s;}\n    .sb.a{background:rgba(0,245,255,.12);color:#67e8f9;border:1px solid rgba(0,245,255,.2);}\n    .sbp.a{background:rgba(124,58,237,.12);color:#c4b5fd;border:1px solid rgba(124,58,237,.2);}\n    .ib{display:flex;align-items:flex-start;gap:10px;background:rgba(124,58,237,.05);border:1px solid rgba(124,58,237,.2);border-radius:10px;padding:12px 14px;margin-bottom:16px;}\n    .ib p{font-family:\'JetBrains Mono\',monospace;font-size:11px;color:rgba(196,181,253,.7);line-height:1.6;}\n    .mg{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:10px;margin-top:14px;}\n    .mc{background:rgba(13,22,40,.8);border:1px solid rgba(26,45,80,.5);border-radius:10px;padding:12px;text-align:center;}\n    .ml{font-family:\'JetBrains Mono\',monospace;font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px;}\n    .mv{font-family:Outfit,sans-serif;font-size:1.25rem;font-weight:700;}\n    .cmc{padding:8px 10px;text-align:center;border:1px solid var(--border);font-family:\'JetBrains Mono\',monospace;font-size:11px;min-width:48px;}\n    .dl{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.25);color:#6ee7b7;text-decoration:none;font-size:12px;font-weight:500;cursor:pointer;transition:all .2s;}\n    .dl:hover{background:rgba(16,185,129,.14);}\n    .spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(0,245,255,.3);border-top-color:#00f5ff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px;}\n    .toast{position:fixed;bottom:20px;right:20px;z-index:9999;padding:10px 18px;border-radius:8px;font-size:12px;background:var(--card);animation:fu .3s ease-out;}\n    @keyframes fu{0%{opacity:0;transform:translateY(10px)}100%{opacity:1;transform:translateY(0)}}\n    @keyframes spin{to{transform:rotate(360deg)}}\n    @media(min-width:768px){.pc{display:grid;grid-template-columns:2fr 1fr;gap:18px;}}\n  </style>\n</head>\n<body>\n<canvas id="bg"></canvas>\n<div id="app">\n  <div class="glass hdr">\n    <div class="hdr-top">\n      <div class="logo">⚗️</div>\n      <div style="flex:1;min-width:0">\n        <div class="model-title" id="mtitle">%%MODEL_TITLE%%</div>\n        <div class="badges" id="mbadges"></div>\n      </div>\n      <div class="status" id="sdot" title="Connecting..."></div>\n    </div>\n    <nav class="nav">\n      <button class="nb active" onclick="showTab(\'ov\')" data-tab="ov">🧠 Overview</button>\n      <button class="nb" onclick="showTab(\'pr\')" data-tab="pr">🔮 Predict</button>\n      <button class="nb" onclick="showTab(\'bt\')" data-tab="bt">📋 Batch</button>\n    </nav>\n  </div>\n\n  <!-- OVERVIEW -->\n  <div id="tab-ov" class="panel active">\n    <div id="scards" class="sg" style="margin-bottom:14px"></div>\n    <div id="oextra"></div>\n  </div>\n\n  <!-- PREDICT -->\n  <div id="tab-pr" class="panel">\n    <div class="pc">\n      <div class="glass sec">\n        <div class="sh"><span>🎛️</span><div><div class="st">Input Features</div><div class="ss" id="fcnt"></div></div>\n          <button onclick="resetForm()" style="margin-left:auto;background:none;border:none;color:#475569;cursor:pointer;font-size:11px;font-family:\'JetBrains Mono\'">Reset</button>\n        </div>\n        <div class="fg" id="pform"></div>\n        <button class="btn" id="pbtn" onclick="doPredict()">🔮 Cast Prediction</button>\n      </div>\n      <div id="rbox"></div>\n    </div>\n  </div>\n\n  <!-- BATCH -->\n  <div id="tab-bt" class="panel">\n    <div class="glass sec">\n      <div class="subs">\n        <button class="sb a" id="sb1" onclick="showSub(\'bp\')">📊 Batch Predict</button>\n        <button class="sb sbp" id="sb2" onclick="showSub(\'tm\')">🧪 Test Model</button>\n      </div>\n      <!-- Batch Predict -->\n      <div id="sub-bp">\n        <div class="sh"><span>📋</span><div><div class="st">Batch Prediction</div><div class="ss">Upload CSV — feature columns only</div></div></div>\n        <div id="bpdz" class="dz" onclick="pf(\'bp\')" ondragover="dov(event,\'bpdz\')" ondragleave="dlv(\'bpdz\')" ondrop="ddrop(event,\'bp\',\'bpdz\')">\n          <div id="bpdc"><div style="font-size:2rem;opacity:.35;margin-bottom:8px">📊</div>\n            <p style="color:#64748b;font-size:13px">Drop CSV or click to browse</p>\n            <p style="color:#334155;font-family:\'JetBrains Mono\',monospace;font-size:11px;margin-top:5px">Feature columns only — no target needed</p>\n          </div>\n        </div>\n        <div id="bppw" style="display:none;margin-top:10px">\n          <div style="display:flex;justify-content:space-between;margin-bottom:4px">\n            <span style="font-size:11px;color:#67e8f9;font-family:\'JetBrains Mono\'">Processing...</span>\n            <span style="font-size:11px;color:#475569;font-family:\'JetBrains Mono\'" id="bppct">0%</span>\n          </div>\n          <div class="pt"><div class="pf" id="bpbar"></div></div>\n        </div>\n        <button id="bpbtn" onclick="runBP()" style="display:none" class="btn">⚡ Run Batch Predictions</button>\n        <div id="bpres" style="margin-top:14px"></div>\n      </div>\n      <!-- Test Model -->\n      <div id="sub-tm" style="display:none">\n        <div class="sh"><span>🧪</span><div><div class="st">Test Model</div><div class="ss" id="tmdesc">Upload CSV with features + actual target values</div></div></div>\n        <div class="ib"><span style="color:#a78bfa;font-size:14px;flex-shrink:0">ℹ️</span>\n          <p>CSV must include both feature columns AND the actual target column <span id="tcname" style="color:#c4b5fd;font-weight:600"></span>. Predictions run on features then compared with actuals to measure accuracy.</p>\n        </div>\n        <div id="tmdz" class="dz dzp" onclick="pf(\'tm\')" ondragover="dov(event,\'tmdz\')" ondragleave="dlv(\'tmdz\')" ondrop="ddrop(event,\'tm\',\'tmdz\')">\n          <div id="tmdc"><div style="font-size:2rem;opacity:.35;margin-bottom:8px">🧪</div>\n            <p style="color:#64748b;font-size:13px">Drop CSV with <span id="tchint" style="color:#a78bfa"></span> column</p>\n            <p style="color:#334155;font-family:\'JetBrains Mono\',monospace;font-size:11px;margin-top:5px">Features + actual values required</p>\n          </div>\n        </div>\n        <button id="tmbtn" onclick="runTM()" style="display:none" class="btn btnp">🧪 Run Evaluation</button>\n        <div id="tmres" style="margin-top:14px"></div>\n      </div>\n    </div>\n  </div>\n</div>\n<input type="file" id="finp-bp" accept=".csv" style="display:none" onchange="hf(\'bp\',this.files[0])">\n<input type="file" id="finp-tm" accept=".csv" style="display:none" onchange="hf(\'tm\',this.files[0])">\n<script>\nconst META=%%META_JSON%%;const SCHEMA=%%SCHEMA_JSON%%;\nlet inp={},bpF=null,tmF=null,bpIv=null;\n\nasync function init(){\n  try{const r=await fetch(\'/model-info\');if(r.ok){const d=await r.json();Object.assign(META,d);if(d.input_schema?.length)SCHEMA.splice(0,SCHEMA.length,...d.input_schema);}document.getElementById(\'sdot\').className=\'status on\';}\n  catch(e){document.getElementById(\'sdot\').title=\'Offline\';}\n  document.getElementById(\'mtitle\').textContent=META.model_name||\'%%MODEL_TITLE%%\';\n  const b=document.getElementById(\'mbadges\');\n  b.innerHTML=[META.problem_type&&`<span class="badge badge-c">${META.problem_type}</span>`,META.best_model&&META.best_model!==\'Unknown\'&&`<span class="badge badge-p">${META.best_model}</span>`,META.eval_metric&&`<span class="badge badge-s">${META.eval_metric}</span>`].filter(Boolean).join(\'\');\n  renderOV();renderForm();\n  const tc=META.label||\'target\';\n  [\'tcname\',\'tchint\'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent=`"${tc}"`;});\n  const td=document.getElementById(\'tmdesc\');if(td)td.textContent=`Upload CSV with features + actual "${tc}" column`;\n}\n\nfunction renderOV(){\n  const grd={c:\'linear-gradient(135deg,rgba(0,245,255,.07),transparent)\',g:\'linear-gradient(135deg,rgba(245,158,11,.07),transparent)\',p:\'linear-gradient(135deg,rgba(124,58,237,.07),transparent)\',j:\'linear-gradient(135deg,rgba(16,185,129,.07),transparent)\',e:\'linear-gradient(135deg,rgba(249,115,22,.07),transparent)\',s:\'linear-gradient(135deg,rgba(100,116,139,.07),transparent)\'};\n  const cl={c:\'#67e8f9\',g:\'#fcd34d\',p:\'#c4b5fd\',j:\'#6ee7b7\',e:\'#fdba74\',s:\'#cbd5e1\'};\n  const stats=[{l:\'Task Type\',v:META.problem_type,i:\'🎯\',c:\'c\'},{l:\'Best Model\',v:META.best_model!==\'Unknown\'?META.best_model:null,i:\'🏆\',c:\'g\'},{l:\'Eval Metric\',v:META.eval_metric,i:\'📐\',c:\'p\'},{l:\'Features\',v:META.num_features,i:\'🧬\',c:\'j\'},{l:\'Target\',v:META.label,i:\'🎯\',c:\'e\'},{l:\'Models Trained\',v:META.n_models||META.leaderboard?.length||\'—\',i:\'🤖\',c:\'s\'}];\n  document.getElementById(\'scards\').innerHTML=stats.map(s=>`<div class="glass sc" style="background:${grd[s.c]}"><div style="display:flex;gap:8px;align-items:flex-start"><span style="font-size:1rem">${s.i}</span><div style="min-width:0"><div class="sl">${s.l}</div>${s.v!=null?`<div class="sv" style="color:${cl[s.c]}">${s.v}</div>`:\'<div style="color:#334155;font-size:11px">—</div>\'}</div></div></div>`).join(\'\');\n  let x=\'\';\n  const lb=META.leaderboard||[];\n  if(lb.length){const md=[\'🥇\',\'🥈\',\'🥉\'];x+=`<div class="glass" style="margin-bottom:12px"><div class="sec"><div class="sh"><span>🏆</span><div><div class="st">Model Leaderboard</div><div class="ss">${lb.length} models trained, ranked by validation score</div></div></div>${lb.map((m,i)=>{const sc=m.score_val??m.score??0,best=i===0;return`<div class="lb-row"><span style="font-size:1rem;width:22px">${md[i]||\'#\'+(i+1)}</span><span style="flex:1;font-family:\'JetBrains Mono\',monospace;font-size:11px;color:${best?\'#67e8f9\':\'#94a3b8\'};font-weight:${best?600:400}">${m.model||m.model_type||\'?\'}</span><span style="font-family:\'JetBrains Mono\',monospace;font-size:11px;color:${best?\'#10b981\':\'#475569\'}">${typeof sc===\'number\'?sc.toFixed(4):sc}</span>${best?\'<span style="font-size:9px;color:#10b981;border:1px solid rgba(16,185,129,.3);background:rgba(16,185,129,.1);border-radius:4px;padding:1px 5px;margin-left:4px;font-family:\\\'JetBrains Mono\\\'">BEST</span>\':\'\'}</div>`}).join(\'\')}</div></div>`;}\n  const fi=META.feature_importance||[];\n  if(fi.length){const top=fi.slice(0,14),mx=Math.max(...top.map(f=>Math.abs(f.importance||0)));x+=`<div class="glass" style="margin-bottom:12px"><div class="sec"><div class="sh"><span>🔥</span><div><div class="st">Feature Importance</div><div class="ss">Top ${top.length} contributing features</div></div></div>${top.map((f,i)=>{const p=mx>0?Math.abs(f.importance||0)/mx*100:0,n=f.feature||f.name||\'Feature \'+i;return`<div class="fi-row"><span class="fi-n" title="${n}">${n}</span><div class="fi-t"><div class="fi-f" style="width:${p}%;background:rgba(0,245,255,${Math.max(.15,1-i*.06)})"></div></div><span class="fi-v">${(f.importance||0).toFixed(4)}</span></div>`}).join(\'\')}</div></div>`;}\n  if([\'binary\',\'multiclass\'].includes(META.problem_type)&&META.classes?.length){x+=`<div class="glass" style="margin-bottom:12px"><div class="sec"><div class="sh"><span>🏷️</span><div><div class="st">Target Classes</div><div class="ss">${META.classes.length} classes</div></div></div><div style="display:flex;flex-wrap:wrap;gap:7px">${META.classes.map(c=>`<span style="border:1px solid rgba(0,245,255,.2);background:rgba(0,245,255,.05);color:#67e8f9;font-family:\'JetBrains Mono\',monospace;font-size:11px;padding:4px 10px;border-radius:6px">${c}</span>`).join(\'\')}</div></div></div>`;}\n  if(SCHEMA.length){x+=`<div class="glass" style="margin-bottom:12px"><div class="sec"><div class="sh"><span>🧬</span><div><div class="st">Feature Schema</div><div class="ss">${SCHEMA.length} input features</div></div></div><div style="overflow-x:auto;border-radius:8px;border:1px solid var(--border)"><table class="tbl"><thead><tr><th>#</th><th>Feature Name</th><th>Type</th><th>Widget</th><th>Median / Mode</th></tr></thead><tbody>${SCHEMA.map((f,i)=>`<tr><td style="color:#334155">${i+1}</td><td style="color:#67e8f9;font-weight:500">${f.name}</td><td>${f.dtype||\'—\'}</td><td><span style="background:rgba(124,58,237,.1);color:#c4b5fd;border-radius:4px;padding:1px 6px;font-size:10px">${f.widget||\'input\'}</span></td><td>${f.median!=null?Number(f.median).toFixed(3):f.mode!=null?f.mode:\'—\'}</td></tr>`).join(\'\')}</tbody></table></div></div></div>`;}\n  document.getElementById(\'oextra\').innerHTML=x;\n}\n\nfunction renderForm(){\n  document.getElementById(\'fcnt\').textContent=SCHEMA.length+\' features\';\n  document.getElementById(\'pform\').innerHTML=SCHEMA.map(f=>{\n    let i=\'\';\n    if(f.widget===\'toggle\')i=`<label class="tw"><input type="checkbox" id="ff_${f.name}" onchange="si(\'${f.name}\',this.checked?1:0)"><div class="tt"></div><span id="tv_${f.name}" style="font-size:12px;color:#94a3b8;font-family:\'JetBrains Mono\'">No (0)</span></label>`;\n    else if([\'dropdown\',\'labeled_dropdown\',\'encoded_dropdown\'].includes(f.widget)){const opts=(f.options||[]).map(o=>typeof o===\'string\'?`<option value="${o}">${o}</option>`:`<option value="${o.value}">${o.label}</option>`).join(\'\');i=`<select id="ff_${f.name}" class="fi" onchange="si(\'${f.name}\',this.value)" style="background:#0d1628"><option value="">Select…</option>${opts}</select>`;}\n    else{const ph=f.median!=null?`median: ${Number(f.median).toFixed(2)}`:\'Enter value…\';i=`<input type="number" id="ff_${f.name}" class="fi" placeholder="${ph}" step="any" oninput="si(\'${f.name}\',this.value)">`;}\n    return`<div><label class="fl">${f.name}</label>${i}</div>`;\n  }).join(\'\');\n}\n\nfunction si(n,v){inp[n]=v;const tv=document.getElementById(\'tv_\'+n);if(tv)tv.textContent=v?\'Yes (1)\':\'No (0)\';}\nfunction resetForm(){inp={};document.querySelectorAll(\'.fi\').forEach(e=>e.value=\'\');document.querySelectorAll(\'.tw input\').forEach(e=>e.checked=false);document.querySelectorAll(\'[id^="tv_"]\').forEach(e=>e.textContent=\'No (0)\');document.getElementById(\'rbox\').innerHTML=\'\';}\n\nasync function doPredict(){\n  const btn=document.getElementById(\'pbtn\');btn.disabled=true;btn.innerHTML=\'<span class="spin"></span>Casting…\';\n  try{const r=await fetch(\'/predict\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({inputs:inp})});if(!r.ok)throw new Error(await r.text());showResult(await r.json());}\n  catch(e){toast(\'Failed: \'+e.message,1);}\n  finally{btn.disabled=false;btn.innerHTML=\'🔮 Cast Prediction\';}\n}\n\nfunction showResult(d){\n  const{prediction,probabilities}=d;\n  const pv=probabilities?Object.values(probabilities).filter(v=>isFinite(v)):[];\n  const mp=pv.length?Math.max(...pv):null;\n  const conf=mp!=null&&isFinite(mp)?Math.round(Math.max(0,Math.min(100,mp*100))):null;\n  const isReg=META.problem_type===\'regression\';\n  const num=parseFloat(prediction);\n  const disp=(!isNaN(num)&&isReg)?num.toLocaleString(\'en-IN\',{maximumFractionDigits:2}):String(prediction);\n  const fs=disp.length>12?\'1.7rem\':disp.length>8?\'2.1rem\':\'2.5rem\';\n  let ph=\'\';\n  if(probabilities){const s=Object.entries(probabilities).filter(([,v])=>isFinite(v)).sort((a,b)=>b[1]-a[1]);if(s.length){ph=`<div style="margin-top:14px"><div style="font-family:\'JetBrains Mono\';font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">Class Probabilities</div>${s.map(([c,p])=>`<div class="pb-w"><span style="font-family:\'JetBrains Mono\';font-size:11px;color:#64748b;width:70px;overflow:hidden;text-overflow:ellipsis">${c}</span><div class="pb-t"><div class="pb-f" style="width:${p*100}%;background:${p===mp?\'#00f5ff\':\'rgba(100,116,139,.4)\'}"></div></div><span style="font-family:\'JetBrains Mono\';font-size:11px;color:#64748b;width:40px;text-align:right">${(p*100).toFixed(1)}%</span></div>`).join(\'\')}</div>`;}}\n  let gh=\'\';\n  if(conf!=null){const gc=conf>=90?\'#10b981\':conf>=70?\'#00f5ff\':conf>=50?\'#f59e0b\':\'#f43f5e\';const r=36,c=2*Math.PI*r,fill=c-(conf/100)*c;const ql=conf>=90?\'excellent\':conf>=70?\'good\':conf>=50?\'fair\':\'low\';gh=`<div style="display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:12px"><div style="position:relative;width:88px;height:88px"><svg viewBox="0 0 100 100" style="width:100%;height:100%;transform:rotate(-90deg)"><circle cx="50" cy="50" r="${r}" fill="none" stroke="#1a2d50" stroke-width="7"/><circle cx="50" cy="50" r="${r}" fill="none" stroke="${gc}" stroke-width="7" stroke-dasharray="${c}" stroke-dashoffset="${fill}" stroke-linecap="round" style="filter:drop-shadow(0 0 6px ${gc}60);transition:stroke-dashoffset .8s cubic-bezier(.4,0,.2,1)"/></svg><div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center"><span style="font-size:1.2rem;font-weight:700;color:${gc}">${conf}%</span><span style="font-family:\'JetBrains Mono\',monospace;font-size:9px;color:#475569">conf</span></div></div><span style="font-family:\'JetBrains Mono\',monospace;font-size:10px;color:${gc};border:1px solid ${gc}40;background:${gc}10;border-radius:12px;padding:2px 8px">${ql}</span></div>`;}\n  document.getElementById(\'rbox\').innerHTML=`<div class="glass" style="padding:18px;margin-top:18px;border:1px solid rgba(0,245,255,.25);animation:fu .4s ease-out"><div class="sh"><span>🎯</span><div><div class="st">Prediction</div><div class="ss">Model output</div></div></div><div class="rv" style="font-size:${fs}">${disp}</div>${isReg?\'<div style="text-align:center;margin-top:6px;color:#475569;font-family:\\\'JetBrains Mono\\\';font-size:11px">regression output</div>\':\'\'}${gh}${ph}</div>`;\n}\n\nfunction showSub(w){\n  document.getElementById(\'sub-bp\').style.display=w===\'bp\'?\'block\':\'none\';\n  document.getElementById(\'sub-tm\').style.display=w===\'tm\'?\'block\':\'none\';\n  document.getElementById(\'sb1\').className=\'sb\'+(w===\'bp\'?\' a\':\'\');\n  document.getElementById(\'sb2\').className=\'sb sbp\'+(w===\'tm\'?\' a\':\'\');\n}\n\nfunction dov(e,id){e.preventDefault();document.getElementById(id).classList.add(\'drag\');}\nfunction dlv(id){document.getElementById(id).classList.remove(\'drag\');}\nfunction ddrop(e,id,dzid){e.preventDefault();dlv(dzid);hf(id,e.dataTransfer.files[0]);}\nfunction pf(id){document.getElementById(\'finp-\'+id).click();}\n\nfunction hf(id,f){\n  if(!f||!f.name.endsWith(\'.csv\')){toast(\'Please upload a .csv file\',1);return;}\n  const dc=id===\'bp\'?\'bpdc\':\'tmdc\';\n  document.getElementById(dc).innerHTML=`<div style="font-size:1.4rem;margin-bottom:6px">📄</div><div style="color:#e2e8f0;font-size:13px">${f.name}</div><div style="color:#475569;font-family:\'JetBrains Mono\';font-size:11px;margin-top:3px">${(f.size/1024).toFixed(1)} KB</div>`;\n  if(id===\'bp\'){bpF=f;document.getElementById(\'bpbtn\').style.display=\'block\';}\n  else{tmF=f;document.getElementById(\'tmbtn\').style.display=\'block\';}\n}\n\nasync function runBP(){\n  if(!bpF)return;\n  const btn=document.getElementById(\'bpbtn\');btn.disabled=true;btn.innerHTML=\'<span class="spin"></span>Processing…\';\n  document.getElementById(\'bppw\').style.display=\'block\';\n  let p=0;bpIv=setInterval(()=>{p=Math.min(p+Math.random()*13,88);sp(\'bp\',p);},400);\n  const fd=new FormData();fd.append(\'file\',bpF);\n  try{const r=await fetch(\'/predict-batch\',{method:\'POST\',body:fd});if(!r.ok)throw new Error(await r.text());const blob=await r.blob();clearInterval(bpIv);sp(\'bp\',100);const url=URL.createObjectURL(blob);document.getElementById(\'bpres\').innerHTML=`<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.2);border-radius:8px"><span style="color:#6ee7b7;font-size:12px">✅ Predictions ready</span><a href="${url}" download="predictions.csv" class="dl">↓ Download CSV</a></div>`;toast(\'Batch complete!\');}\n  catch(e){clearInterval(bpIv);toast(\'Failed: \'+e.message,1);}\n  finally{btn.disabled=false;btn.innerHTML=\'⚡ Run Batch Predictions\';}\n}\n\nasync function runTM(){\n  if(!tmF)return;\n  const btn=document.getElementById(\'tmbtn\');btn.disabled=true;btn.innerHTML=\'<span class="spin"></span>Evaluating…\';\n  const fd=new FormData();fd.append(\'file\',tmF);\n  try{const r=await fetch(\'/test-model\',{method:\'POST\',body:fd});if(!r.ok)throw new Error(await r.text());showTMRes(await r.json());toast(\'Evaluation complete!\');}\n  catch(e){toast(\'Failed: \'+e.message,1);}\n  finally{btn.disabled=false;btn.innerHTML=\'🧪 Run Evaluation\';}\n}\n\nfunction showTMRes(d){\n  const isReg=META.problem_type===\'regression\';\n  const mc=(n,v)=>{const num=parseFloat(v);if([\'R\\u00b2\',\'Accuracy\',\'ROC-AUC\',\'Weighted F1\'].includes(n))return num>=0.9?\'#10b981\':num>=0.7?\'#00f5ff\':num>=0.5?\'#f59e0b\':\'#f43f5e\';return\'#67e8f9\';};\n  let h=`<div style="padding:12px 14px;background:rgba(16,185,129,.04);border:1px solid rgba(16,185,129,.2);border-radius:10px;margin-bottom:14px"><div style="color:#6ee7b7;font-size:12px;font-family:\'JetBrains Mono\'">✅ Evaluated on ${(d.n_samples||0).toLocaleString()} samples</div></div>\n  <div class="mg">${Object.entries(d.metrics||{}).filter(([,v])=>v!=null).map(([k,v])=>{const num=parseFloat(v),col=mc(k,v),disp=typeof v===\'number\'?(Math.abs(v)<10?v.toFixed(4):v.toFixed(2)):String(v);return`<div class="mc"><div class="ml">${k}</div><div class="mv" style="color:${col}">${disp}</div>${(typeof num===\'number\'&&isFinite(num)&&[\'R\\u00b2\',\'Accuracy\',\'ROC-AUC\'].includes(k))?`<div style="height:3px;background:#1a2d50;border-radius:2px;margin-top:7px;overflow:hidden"><div style="height:3px;border-radius:2px;width:${Math.max(0,Math.min(100,num*100))}%;background:${col}"></div></div>`:\'\'}</div>`;}).join(\'\')}</div>`;\n  if(d.confusion_matrix){const{matrix,labels}=d.confusion_matrix,mx=Math.max(...matrix.flat()),tot=matrix.flat().reduce((a,b)=>a+b,0);h+=`<div style="margin-top:16px"><div style="font-family:\'JetBrains Mono\',monospace;font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Confusion Matrix (${tot} samples)</div><div style="overflow-x:auto"><table style="border-collapse:collapse"><thead><tr><th class="cmc" style="color:#475569;font-size:10px">actual ↓ / pred →</th>${labels.map(l=>`<th class="cmc" style="color:#67e8f9">${l}</th>`).join(\'\')}</tr></thead><tbody>${matrix.map((row,i)=>`<tr><th class="cmc" style="color:#67e8f9">${labels[i]}</th>${row.map((val,j)=>{const diag=i===j,it=mx>0?val/mx:0,bg=diag?`rgba(0,245,255,${.04+it*.2})`:val>0?`rgba(244,63,94,${.04+it*.16})`:\'transparent\',rt=row.reduce((a,b)=>a+b,0),pct=rt>0?Math.round(val/rt*100):0;return`<td class="cmc" style="background:${bg}"><span style="color:${diag?\'#67e8f9\':val>0?\'#f87171\':\'#334155\'};font-weight:${diag?700:400}">${val}</span>${val>0?`<div style="font-size:9px;color:#475569">${pct}%</div>`:\'\'}</td>`;}).join(\'\')}</tr>`).join(\'\')}</tbody></table></div></div>`;}\n  if(d.per_class&&Object.keys(d.per_class).length){h+=`<div style="margin-top:16px"><div style="font-family:\'JetBrains Mono\',monospace;font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Per-Class Performance</div><div style="overflow-x:auto;border-radius:8px;border:1px solid var(--border)"><table class="tbl"><thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1</th></tr></thead><tbody>${Object.entries(d.per_class).map(([cls,m])=>`<tr><td style="color:#c4b5fd">${cls}</td><td style="color:#67e8f9">${(m.precision??0).toFixed(3)}</td><td style="color:#a78bfa">${(m.recall??0).toFixed(3)}</td><td style="color:#f97316">${(m[\'f1-score\']??0).toFixed(3)}</td></tr>`).join(\'\')}</tbody></table></div></div>`;}\n  document.getElementById(\'tmres\').innerHTML=h;\n}\n\nfunction sp(id,v){document.getElementById(id===\'bp\'?\'bpbar\':\'\').style.width=v+\'%\';document.getElementById(id===\'bp\'?\'bppct\':\'\').textContent=Math.round(v)+\'%\';}\nfunction showTab(id){document.querySelectorAll(\'.panel\').forEach(p=>p.classList.remove(\'active\'));document.querySelectorAll(\'.nb\').forEach(b=>b.classList.toggle(\'active\',b.dataset.tab===id));document.getElementById(\'tab-\'+id).classList.add(\'active\');}\nfunction toast(msg,err=0){const t=document.createElement(\'div\');t.className=\'toast\';t.textContent=msg;t.style.cssText+=`;border:1px solid ${err?\'rgba(244,63,94,.5)\':\'rgba(0,245,255,.4)\'};color:${err?\'#f87171\':\'#67e8f9\'}`;document.body.appendChild(t);setTimeout(()=>t.remove(),4000);}\n\n(function(){const cv=document.getElementById(\'bg\'),ctx=cv.getContext(\'2d\');const rz=()=>{cv.width=innerWidth;cv.height=innerHeight;};rz();addEventListener(\'resize\',rz);const pts=Array.from({length:50},()=>({x:Math.random()*innerWidth,y:Math.random()*innerHeight,vx:(Math.random()-.5)*.3,vy:(Math.random()-.5)*.3,r:Math.random()*1.5+.4,op:Math.random()*.35+.08,c:Math.random()>.6?\'0,245,255\':Math.random()>.5?\'124,58,237\':\'249,115,22\'}));function draw(){ctx.clearRect(0,0,cv.width,cv.height);for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++){const dx=pts[i].x-pts[j].x,dy=pts[i].y-pts[j].y,d=Math.sqrt(dx*dx+dy*dy);if(d<100){ctx.beginPath();ctx.moveTo(pts[i].x,pts[i].y);ctx.lineTo(pts[j].x,pts[j].y);ctx.strokeStyle=`rgba(0,245,255,${(1-d/100)*.06})`;ctx.lineWidth=.5;ctx.stroke();}}pts.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle=`rgba(${p.c},${p.op})`;ctx.fill();p.x+=p.vx;p.y+=p.vy;if(p.x<0)p.x=cv.width;if(p.x>cv.width)p.x=0;if(p.y<0)p.y=cv.height;if(p.y>cv.height)p.y=0;});requestAnimationFrame(draw);}draw();})();\ninit();\n</script>\n</body>\n</html>'


def _build_deployment_html(sess: dict) -> str:
    meta         = sess.get("metadata", {})
    schema       = meta.get("input_schema", [])
    model_name   = sess.get("deployment_name", "ML Model")
    model_title  = model_name.replace("_", " ").title()
    problem_type = meta.get("problem_type", "unknown")
    best_model   = meta.get("best_model", "Unknown")
    eval_metric  = str(meta.get("eval_metric", ""))
    target_col   = meta.get("label", "target")
    classes_list = meta.get("classes", [])
    n_features   = len(schema)
    leaderboard  = meta.get("leaderboard", [])
    fi_list      = meta.get("feature_importance", [])

    schema_js = json.dumps(schema, default=str)
    meta_js   = json.dumps({
        "model_name":         model_title,
        "problem_type":       problem_type,
        "best_model":         best_model,
        "eval_metric":        eval_metric,
        "label":              target_col,
        "classes":            classes_list,
        "num_features":       n_features,
        "n_models":           len(leaderboard),
        "feature_importance": fi_list[:12],
        "leaderboard":        leaderboard[:5],
    }, default=str)

    html = _DEPLOY_HTML_TEMPLATE
    html = html.replace("%%MODEL_TITLE%%", model_title)
    html = html.replace("%%META_JSON%%",   meta_js)
    html = html.replace("%%SCHEMA_JSON%%", schema_js)
    return html



# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "sessions": len(SESSIONS)}


# ── Serve React frontend build (production) ───────────────────────────────────
# This lets a single Python process serve both the API and the React SPA.
# In development (npm run dev), Vite's proxy handles /api → backend.
# In production (HuggingFace / Docker), FastAPI serves the built static files.
import pathlib as _pl

_STATIC_DIR = _pl.Path(__file__).parent.parent / "static"

if _STATIC_DIR.is_dir():
    from fastapi.staticfiles import StaticFiles as _SF
    from fastapi.responses import FileResponse as _FR

    # Mount /assets and other hashed files
    _assets = _STATIC_DIR / "assets"
    if _assets.is_dir():
        app.mount("/assets", _SF(directory=str(_assets)), name="assets")

    # Catch-all: serve index.html for any non-API route (React Router support)
    @app.get("/{full_path:path}", include_in_schema=False)
    async def _serve_spa(full_path: str):
        # Never intercept API routes
        if full_path.startswith("api/"):
            from fastapi import HTTPException as _HE
            raise _HE(404)
        index = _STATIC_DIR / "index.html"
        if index.is_file():
            return _FR(str(index))
        from fastapi import HTTPException as _HE
        raise _HE(404, detail="Frontend not built. Run: cd frontend && npm run build")
