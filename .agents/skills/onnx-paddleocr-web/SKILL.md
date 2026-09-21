---
name: onnx-paddleocr-web
description: ONNX Runtime Web OCR execution pipeline with PaddleOCR models for in-browser overtime document verification.
---

# ONNX Web & PaddleOCR Pipeline

## 1. Model Assets & Purpose
- **Text Detection**: `ch_PP-OCRv4_det` (Detect bounding boxes of text lines).
- **Text Direction Classifier**: `ch_ppocr_mobile_v2.0_cls.onnx` (Rotate vertical/upside-down text).
- **Text Recognition**: `latin_PP-OCRv3_rec.onnx` & `ch_PP-OCRv4_rec.onnx` with `latin_dict.txt` (Vietnamese diacritic & Latin character support).

## 2. In-Browser Web Worker Execution Pipeline
1. **Input**: Image file (JPG/PNG of Overtime authorization slips).
2. **Pre-processing (OffscreenCanvas in Web Worker)**:
   - Resize, normalize `(val / 255.0 - 0.5) / 0.5`.
   - Convert to `Float32Array` tensor `[1, 3, H, W]`.
3. **Inference (`onnxruntime-web`)**:
   - Run detection -> Extract polygon boxes.
   - Run classification -> Angle correction (0 vs 180 deg).
   - Run recognition -> Map greedy CTC argmax indices to `latin_dict.txt`.
4. **Post-processing & Pattern Matching**:
   - Extract Employee ID regex: `/(?:LEP|LP)\s*0*\d{1,4}/i`.
   - Extract Date regex: `/\b\d{1,2}[\/\-\.]\d{1,2}(?:[\/\-\.]\d{2,4})?\b/`.
   - Extract OT Hours regex: `/\b(\d+(?:\.\d+)?)\s*(?:giờ|h|hours?|hrs?|tiếng)\b/i`.
5. **State Reconciliation**:
    - Lookup `employee_id` + `date` in Supabase `overtime_records`.
   - If OT hours match recorded hours within tolerance -> Set status = `MATCHED` (Green `#D1FAE5`).
   - If OT hours differ or employee not found -> Set status = `MISMATCH` (Red `#FEE2E2`).
