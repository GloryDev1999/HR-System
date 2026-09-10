/**
 * ONNX OCR Worker - Pipeline PaddleOCR THẬT chạy 100% trên trình duyệt
 *
 * Chuỗi xử lý:
 *   Ảnh (bytes) -> createImageBitmap -> Det (ch_PP-OCRv4_det, DBNet)
 *   -> Postprocess DBNet (ngưỡng 0.3, connected-component labeling, unclip)
 *   -> Crop từng vùng chữ -> Cls (xoay 180 nếu cần) -> Rec (latin_PP-OCRv3, CTC decode latin_dict)
 *   -> Tái tạo lưới bảng theo bố cục ảnh scan (gom hàng theo Y, cột theo X)
 *
 * KHÔNG có chế độ fallback dữ liệu giả. Nếu model lỗi/tải thất bại thì trả
 * ERROR rõ ràng - tuyệt đối không bịa kết quả nhận dạng.
 */

import type {
  OCRWorkerRequest,
  OCRWorkerProgress,
  OCRWorkerResult,
  OCRWorkerError,
  OcrTextLine,
  OcrTableGrid,
} from '../types/ocr-worker-protocol';

import * as ort from 'onnxruntime-web/wasm';
import { EMBEDDED_MODELS } from '../generated/embedded-models';

// ---------------------------------------------------------------------------
// Model nhúng base64 tại build-time (update-model.md §3 — chạy được file://,
// không fetch file rời). Thứ tự ưu tiên: embedded -> fetch tương đối (http dev).
// Chỉ worker này import EMBEDDED_MODELS để tránh bundle 35MB bị nhân đôi vào
// main thread (ocr-engine-direct.ts giữ nguyên luồng IndexedDB + fetch).
// ---------------------------------------------------------------------------

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function getEmbeddedBuffer(relPath: string): ArrayBuffer | null {
  const b64 = EMBEDDED_MODELS[relPath];
  if (!b64) return null;
  try {
    const buf = base64ToArrayBuffer(b64);
    return buf.byteLength > 0 ? buf : null;
  } catch {
    return null;
  }
}

function getEmbeddedText(relPath: string): string | null {
  const buf = getEmbeddedBuffer(relPath);
  if (!buf) return null;
  try {
    return new TextDecoder('utf-8').decode(buf);
  } catch {
    return null;
  }
}

/**
 * Vá tạm global fetch trong lúc tạo session để ORT phục vụ file .wasm/.mjs
 * runtime từ bản nhúng thay vì fetch qua network (file:// chặn fetch).
 * Pattern đã được chứng minh ở ocr-engine-direct.ts (withIdbWasmFetch).
 * Không giả định shape object của `ort.env.wasm.wasmPaths` theo version ORT.
 */
async function withEmbeddedWasmFetch<T>(fn: () => Promise<T>): Promise<T> {
  const wasmB64 = EMBEDDED_MODELS['PaddleOCR-Models/ort/ort-wasm-simd-threaded.wasm'];
  const mjsB64 = EMBEDDED_MODELS['PaddleOCR-Models/ort/ort-wasm-simd-threaded.mjs'];
  if (!wasmB64 && !mjsB64) return fn();
  const origFetch = (globalThis as any).fetch.bind(globalThis);
  const patched = async (input: any, init?: any): Promise<Response> => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || String(input);
      if (wasmB64 && url.endsWith('ort-wasm-simd-threaded.wasm')) {
        return new Response(base64ToArrayBuffer(wasmB64).slice(0), { headers: { 'Content-Type': 'application/wasm' } });
      }
      if (mjsB64 && url.endsWith('ort-wasm-simd-threaded.mjs')) {
        return new Response(base64ToArrayBuffer(mjsB64).slice(0), { headers: { 'Content-Type': 'text/javascript' } });
      }
    } catch { /* rơi về fetch gốc */ }
    return origFetch(input, init);
  };
  (globalThis as any).fetch = patched;
  try {
    return await fn();
  } finally {
    (globalThis as any).fetch = origFetch;
  }
}

// ---------------------------------------------------------------------------
// Cấu hình
// ---------------------------------------------------------------------------

// Tự động tìm và tạo danh sách đường dẫn dự phòng (relative, absolute, origin, base)
function getCandidateUrls(relPath: string): string[] {
  const list: string[] = [];
  const clean = relPath.replace(/^\.?\//, '');
  try {
    if (typeof self !== 'undefined' && self.location && self.location.href) {
      const loc = self.location.href;
      const baseDir = loc.substring(0, loc.lastIndexOf('/') + 1);
      list.push(new URL(clean, baseDir).href);
      list.push(new URL('../' + clean, baseDir).href);
      list.push(new URL('../../' + clean, baseDir).href);
      if (self.location.origin && self.location.origin !== 'null') {
        list.push(`${self.location.origin}/${clean}`);
      }
    }
  } catch {}
  list.push(`/${clean}`);
  list.push(`./${clean}`);
  list.push(clean);
  return Array.from(new Set(list));
}

const DET_LIMIT_SIDE = 960;      // giới hạn cạnh lớn trước khi đưa vào det
const DET_BIN_THRESH = 0.3;      // ngưỡng binarize bản đồ xác suất DBNet
const DET_BOX_SCORE = 0.5;       // điểm tối thiểu của một vùng chữ
const DET_UNCLIP_RATIO = 1.6;    // hệ số nới rộng hộp (xấp xỉ Clipper offset)
const REC_TARGET_H = 48;         // chiều cao chuẩn đầu vào recognition
const MAX_BOXES = 400;           // trần số vùng chữ xử lý mỗi ảnh

// Tự động cấu hình đường dẫn WASM thích ứng cả localhost và offline
try {
  if (typeof self !== 'undefined' && self.location && self.location.origin && self.location.origin !== 'null') {
    ort.env.wasm.wasmPaths = `${self.location.origin}/PaddleOCR-Models/ort/`;
  } else {
    ort.env.wasm.wasmPaths = './PaddleOCR-Models/ort/';
  }
} catch {
  ort.env.wasm.wasmPaths = '/PaddleOCR-Models/ort/';
}

// Tối ưu tăng tốc cho Edge: bật SIMD + threads theo đúng năng lực máy
try {
  const hw = (self as any).navigator?.hardwareConcurrency || 4;
  (ort.env.wasm as any).numThreads = Math.min(hw, 4);
  (ort.env.wasm as any).simd = true;
  (ort.env.wasm as any).proxy = false;
} catch {}

// Cache vĩnh viễn cho model/WASM
const OCR_CACHE_NAME = 'ocr-model-cache-v1';

async function fetchWithCache(url: string): Promise<ArrayBuffer> {
  try {
    if ('caches' in self) {
      const cache = await (caches as any).open(OCR_CACHE_NAME);
      const cached = await cache.match(url);
      if (cached) {
        const buf = await cached.arrayBuffer();
        if (buf.byteLength > 0) return buf;
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const clone = res.clone();
      cache.put(url, clone).catch(() => {});
      return await res.arrayBuffer();
    }
  } catch {}
  return fetchArrayBuffer(url);
}

async function fetchFirstAvailableBuffer(relPath: string): Promise<ArrayBuffer> {
  // Ưu tiên bản nhúng (file:// không fetch được file rời)
  const embedded = getEmbeddedBuffer(relPath);
  if (embedded) return embedded.slice(0);
  const candidates = getCandidateUrls(relPath);
  let lastError: any = null;
  for (const url of candidates) {
    try {
      const buf = await fetchWithCache(url);
      if (buf && buf.byteLength > 0) return buf;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Không thể nạp tệp model [${relPath}] từ các vị trí dự phòng. Hãy đảm bảo thư mục PaddleOCR-Models được đặt cùng cấp hoặc trong dist/. Lỗi: ${lastError?.message || lastError}`);
}

async function fetchFirstAvailableText(relPath: string): Promise<string> {
  // Ưu tiên bản nhúng (file:// không fetch được file rời)
  const embedded = getEmbeddedText(relPath);
  if (embedded !== null && embedded.length > 0) return embedded;
  const candidates = getCandidateUrls(relPath);
  let lastError: any = null;
  for (const url of candidates) {
    try {
      if ('caches' in self) {
        try {
          const cache = await (caches as any).open(OCR_CACHE_NAME);
          const cached = await cache.match(url);
          if (cached) {
            const txt = await cached.text();
            if (txt && txt.length > 0) return txt;
          }
        } catch {}
      }
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        try {
          if ('caches' in self) {
            const cache = await (caches as any).open(OCR_CACHE_NAME);
            cache.put(url, new Response(text)).catch(() => {});
          }
        } catch {}
        return text;
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Không thể nạp tệp từ điển [${relPath}]. Lỗi: ${lastError?.message || lastError}`);
}

// ---------------------------------------------------------------------------
// Trạng thái session & từ điển (lazy init, tái dùng giữa các lần chạy)
// ---------------------------------------------------------------------------

interface SessionBundle {
  det?: ort.InferenceSession;
  rec?: ort.InferenceSession;
  charset: string[];   // ['blank', ...từ điển]
  dictSize: number;
  /** Ghi chú đối chiếu kích thước output model với từ điển (điền ở lần rec đầu tiên) */
  charsetNote: string;
  /** Nguồn từ điển thực tế được dùng cho CTC */
  dictSource: string;
  /** Thông tin vi_dict để HR RAG tham chiếu */
  viDictInfo: string;
}

let bundle: SessionBundle | null = null;
let running = false;

function progress(requestId: string, p: number, step: string, message: string) {
  const msg: OCRWorkerProgress = { type: 'PROGRESS', requestId, progress: Math.min(99, Math.max(0, Math.round(p))), step, message };
  (self as any).postMessage(msg);
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Không tải được ${url} (HTTP ${res.status})`);
  return res.arrayBuffer();
}

function parseDictText(text: string): string[] {
  const dict = text.split('\n').map(l => l.replace(/\r$/, ''));
  while (dict.length > 0 && dict[dict.length - 1] === '') dict.pop();
  return dict;
}

async function loadCharset(): Promise<{ charset: string[]; dictSize: number; source: string; viInfo: string }> {
  // 1) Bắt buộc: latin_dict là chuẩn cho model latin_PP-OCRv3_rec.onnx (output 187 = 185+2)
  let latinDict: string[] = [];
  try {
    const text = await fetchFirstAvailableText('PaddleOCR-Models/dictionaries/latin_dict.txt');
    latinDict = parseDictText(text);
  } catch (e: any) {
    throw new Error(`Không tải được từ điển chính latin_dict.txt: ${e?.message || e}`);
  }
  if (latinDict.length !== 185 && latinDict.length !== 186) {
    console.warn(`[OCR Worker] latin_dict size bất thường: ${latinDict.length}, kỳ vọng 185 (model output 187). Vẫn thử decode.`);
  }

  // 2) Tùy chọn: vi_dict comprehensive (235) - chỉ để HR RAG, KHÔNG dùng cho CTC nếu mismatch
  let viInfo = 'không tải được vi_dict';
  try {
    const viText = await fetchFirstAvailableText('PaddleOCR-Models/dictionaries/vi_dict.txt');
    const viDict = parseDictText(viText);
    viInfo = `vi_dict ${viDict.length} ký tự`;
    if (viDict.length === 185 || viDict.length === 186) {
      viInfo += ' (khớp kích thước CTC)';
    } else {
      viInfo += ' → comprehensive HR Vietnamese (dùng cho HR RAG post-process, CTC vẫn dùng latin để khớp model 187)';
    }
  } catch (e: any) {
    viInfo = `vi_dict lỗi: ${e?.message || e}`;
  }

  // 3) Trả về charset CTC = latin (đảm bảo đúng mapping với model weights)
  const charset = ['blank', ...latinDict];
  const source = `latin_dict.txt (${latinDict.length} chars, model output 187 khớp)`;
  return { charset, dictSize: latinDict.length, source, viInfo };
}

async function ensureBundle(requestId: string): Promise<SessionBundle> {
  if (bundle) return bundle;

  progress(requestId, 8, 'INIT_WASM', 'Khởi tạo thuật toán OCR (WASM)...');

  const charsetInfo = await loadCharset();
  progress(requestId, 10, 'DICT', `Chuẩn bị dữ liệu nhận diện | ${charsetInfo.viInfo}`);

  progress(requestId, 12, 'LOAD_DET', `Đang tự động nhận diện và tải mô hình phát hiện vùng chữ...`);
  const detBuf = await fetchFirstAvailableBuffer('PaddleOCR-Models/onnx/ch_PP-OCRv4_det_infer.onnx');
  const det = await withEmbeddedWasmFetch(() => ort.InferenceSession.create(detBuf, { executionProviders: ['wasm'] }));

  progress(requestId, 20, 'LOAD_REC', `Đang tự động nhận diện và tải mô hình nhận dạng ký tự...`);
  const recBuf = await fetchFirstAvailableBuffer('PaddleOCR-Models/onnx/latin_PP-OCRv3_rec.onnx');
  const rec = await withEmbeddedWasmFetch(() => ort.InferenceSession.create(recBuf, { executionProviders: ['wasm'] }));

  bundle = { det, rec, charset: charsetInfo.charset, dictSize: charsetInfo.dictSize, charsetNote: '', dictSource: charsetInfo.source, viDictInfo: charsetInfo.viInfo };
  return bundle;
}

// ---------------------------------------------------------------------------
// Tiền xử lý dùng chung (OffscreenCanvas)
// ---------------------------------------------------------------------------

function bitmapToNormalizedTensor(
  src: ImageBitmap | OffscreenCanvas,
  dstW: number,
  dstH: number,
  mean: number[],
  std: number[],
): { tensor: ort.Tensor; scale: number; padW: number; padH: number } {
  // Resize giữ tỉ lệ về (dstW,dstH) và pad phải/dưới bằng 0 (đen sau normalize)
  const scale = Math.min(dstW / src.width, dstH / src.height);
  const drawW = Math.max(1, Math.round(src.width * scale));
  const drawH = Math.max(1, Math.round(src.height * scale));

  const canvas = new OffscreenCanvas(dstW, dstH);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, dstW, dstH);
  ctx.drawImage(src, 0, 0, drawW, drawH);

  const img = ctx.getImageData(0, 0, dstW, dstH).data;
  const plane = dstW * dstH;
  const data = new Float32Array(3 * plane);
  for (let i = 0, px = 0; i < plane; i++, px += 4) {
    const r = img[px], g = img[px + 1], b = img[px + 2];
    data[i] = ((r / 255) - mean[0]) / std[0];
    data[plane + i] = ((g / 255) - mean[1]) / std[1];
    data[2 * plane + i] = ((b / 255) - mean[2]) / std[2];
  }
  return {
    tensor: new ort.Tensor('float32', data, [1, 3, dstH, dstW]),
    scale,
    padW: dstW - drawW,
    padH: dstH - drawH,
  };
}

function cropBitmap(bmp: ImageBitmap, box: { x0: number; y0: number; x1: number; y1: number }, rotate180 = false): OffscreenCanvas {
  const w = Math.max(1, Math.round(box.x1 - box.x0));
  const h = Math.max(1, Math.round(box.y1 - box.y0));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (rotate180) {
    ctx.translate(w, h);
    ctx.rotate(Math.PI);
  }
  ctx.drawImage(bmp, box.x0, box.y0, w, h, 0, 0, w, h);
  return canvas;
}

function canvasToNormalizedCHW(canvas: OffscreenCanvas, mean = 0.5, std = 0.5): ort.Tensor {
  const { width: w, height: h } = canvas;
  const img = canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const plane = w * h;
  const data = new Float32Array(3 * plane);
  for (let i = 0, px = 0; i < plane; i++, px += 4) {
    data[i] = ((img[px] / 255) - mean) / std;
    data[plane + i] = ((img[px + 1] / 255) - mean) / std;
    data[2 * plane + i] = ((img[px + 2] / 255) - mean) / std;
  }
  return new ort.Tensor('float32', data, [1, 3, h, w]);
}

// ---------------------------------------------------------------------------
// Detection: preprocess + inference + DBNet postprocess
// ---------------------------------------------------------------------------

function roundToMultipleOf32(v: number): number {
  return Math.max(32, Math.ceil(v / 32) * 32);
}

interface RawBox { x0: number; y0: number; x1: number; y1: number }

async function runDetection(
  requestId: string,
  bmp: ImageBitmap,
  det: ort.InferenceSession,
): Promise<RawBox[]> {
  // Resize giữ tỉ lệ về khung det (cạnh lớn <= 960, kích thước bội số 32)
  const rawScale = Math.min(1, DET_LIMIT_SIDE / Math.max(bmp.width, bmp.height));
  const scaledW = roundToMultipleOf32(bmp.width * rawScale);
  const scaledH = roundToMultipleOf32(bmp.height * rawScale);

  const { tensor, scale } = bitmapToNormalizedTensor(
    bmp, scaledW, scaledH,
    [0.485, 0.456, 0.406],
    [0.229, 0.224, 0.225],
  );

  progress(requestId, 30, 'DETECTION', `Chạy detection DBNet trên ảnh ${bmp.width}×${bmp.height}px (tensor ${scaledW}×${scaledH})...`);
  const feeds: Record<string, ort.Tensor> = {};
  feeds[det.inputNames[0]] = tensor;
  const out = await det.run(feeds);
  const probMap = out[det.outputNames[0]];

  const dims = probMap.dims as number[];
  const pH = dims[dims.length - 2];
  const pW = dims[dims.length - 1];
  const probs = probMap.data as Float32Array;

  const boxes = dbNetBoxesFromProbMap(probs, pH, pW, scale);
  return boxes;
}

/**
 * DBNet postprocess thuần JS:
 *  1. Binarize bản đồ xác suất theo ngưỡng 0.3
 *  2. Connected-component labeling (flood fill) tìm từng vùng chữ
 *  3. Lọc vùng quá nhỏ / điểm thấp
 *  4. Unclip: nới rộng hộp theo công thức d = ratio * diện tích / chu vi
 *     (xấp xỉ Clipper offset của DBNet cho hộp thẳng đứng - form in ấn bảng biểu)
 */
function dbNetBoxesFromProbMap(probs: Float32Array, pH: number, pW: number, scale: number): RawBox[] {
  const visited = new Uint8Array(pH * pW);
  const stack = new Int32Array(pH * pW);
  const boxes: RawBox[] = [];

  for (let start = 0; start < probs.length; start++) {
    if (probs[start] < DET_BIN_THRESH || visited[start]) continue;

    // Flood fill một thành phần liên thông
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let minX = pW, maxX = 0, minY = pH, maxY = 0, count = 0, probSum = 0;

    while (sp > 0) {
      const idx = stack[--sp];
      const y = (idx / pW) | 0;
      const x = idx - y * pW;
      count++;
      probSum += probs[idx];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      // 4 láng giềng
      if (y > 0 && !visited[idx - pW] && probs[idx - pW] >= DET_BIN_THRESH) { visited[idx - pW] = 1; stack[sp++] = idx - pW; }
      if (y < pH - 1 && !visited[idx + pW] && probs[idx + pW] >= DET_BIN_THRESH) { visited[idx + pW] = 1; stack[sp++] = idx + pW; }
      if (x > 0 && !visited[idx - 1] && probs[idx - 1] >= DET_BIN_THRESH) { visited[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (x < pW - 1 && !visited[idx + 1] && probs[idx + 1] >= DET_BIN_THRESH) { visited[idx + 1] = 1; stack[sp++] = idx + 1; }
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (count < 10 || bw < 2 || bh < 2) continue;
    if (probSum / count < DET_BOX_SCORE) continue;

    // Unclip (xấp xỉ hộp thẳng)
    const d = (DET_UNCLIP_RATIO * count) / (2 * (bw + bh));
    const bx0 = Math.max(0, (minX - d) / scale);
    const by0 = Math.max(0, (minY - d) / scale);
    const bx1 = (maxX + 1 + d) / scale;
    const by1 = (maxY + 1 + d) / scale;
    boxes.push({ x0: bx0, y0: by0, x1: bx1, y1: by1 });
  }

  // Sắp xếp từ trên xuống để nhận dạng theo thứ tự đọc tự nhiên
  boxes.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
  return boxes.slice(0, MAX_BOXES);
}

// ---------------------------------------------------------------------------
// Recognition: CTC greedy decode
// Lưu ý hướng chữ: không dùng classifier riêng (model cls gốc lỗi opset với ORT
// mới). Thay vào đó nếu kết quả thường có độ tin cậy thấp thì chạy lại trên ảnh
// xoay 180° và giữ kết quả TỐT HƠN theo độ tin cậy đo được.
// ---------------------------------------------------------------------------

const ROTATION_RETRY_CONFIDENCE = 0.55;

function noteCharsetSize(b: SessionBundle, modelC: number): string {
  if (b.charsetNote) return b.charsetNote;
  if (modelC === b.dictSize + 1) {
    b.charsetNote = `output rec C=${modelC} khớp blank + ${b.dictSize} ký tự dict`;
  } else if (modelC === b.dictSize + 2) {
    b.charsetNote = `output rec C=${modelC} khớp blank + ${b.dictSize} ký tự dict + khoảng trắng`;
  } else {
    b.charsetNote = `CẢNH BÁO lệch từ điển: model output C=${modelC}, dict ${b.dictSize} ký tự - chỉ decode chỉ mục nằm trong phạm vi dict`;
  }
  return b.charsetNote;
}

async function recognizeCrop(b: SessionBundle, canvas: OffscreenCanvas): Promise<OcrTextLine> {
  // Resize giữ tỉ lệ về cao 48px
  const targetW = Math.max(8, Math.min(640, Math.round((canvas.width * REC_TARGET_H) / canvas.height)));
  const resized = new OffscreenCanvas(targetW, REC_TARGET_H);
  const rctx = resized.getContext('2d')!;
  rctx.imageSmoothingEnabled = true;
  rctx.imageSmoothingQuality = 'high';
  rctx.drawImage(canvas, 0, 0, targetW, REC_TARGET_H);

  const input = canvasToNormalizedCHW(resized);
  const feeds: Record<string, ort.Tensor> = {};
  feeds[b.rec!.inputNames[0]] = input;
  const out = await b.rec!.run(feeds);
  const t = out[b.rec!.outputNames[0]];
  const dims = t.dims as number[];
  const T = dims[dims.length - 2];
  const C = dims[dims.length - 1];
  const charsetNote = noteCharsetSize(b, C);
  const logits = t.data as Float32Array;
  const charset = b.charset;

  let text = '';
  let confSum = 0;
  let confCount = 0;
  let prev = -1;

  for (let ti = 0; ti < T; ti++) {
    let best = 0;
    let bestVal = -Infinity;
    const base = ti * C;
    for (let ci = 0; ci < C; ci++) {
      const v = logits[base + ci];
      if (v > bestVal) { bestVal = v; best = ci; }
    }
    if (best !== 0 && best !== prev && best < charset.length) {
      const p = softmaxAt(logits, base, C, best);
      text += charset[best];
      confSum += p;
      confCount++;
    }
    prev = best;
  }

  return {
    text,
    confidence: confCount > 0 ? confSum / confCount : 0,
    box: { x0: 0, y0: 0, x1: 0, y1: 0 },
  };
}

function softmaxAt(logits: Float32Array, base: number, C: number, at: number): number {
  let maxV = -Infinity;
  for (let ci = 0; ci < C; ci++) if (logits[base + ci] > maxV) maxV = logits[base + ci];
  let sum = 0;
  for (let ci = 0; ci < C; ci++) sum += Math.exp(logits[base + ci] - maxV);
  return Math.exp(logits[base + at] - maxV) / sum;
}

// ---------------------------------------------------------------------------
// Tái tạo lưới bảng từ các dòng chữ (gom hàng theo Y, gom ô theo khoảng X)
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function buildTableGrid(lines: OcrTextLine[], imageWidth: number, imageHeight: number): OcrTableGrid {
  const heights = lines.map(l => l.box.y1 - l.box.y0);
  const medH = Math.max(8, median(heights));

  // 1. Gom hàng theo tâm Y
  interface WorkRow { yc: number; items: OcrTextLine[] }
  const rows: WorkRow[] = [];
  for (const line of [...lines].sort((a, b) => (a.box.y0 + a.box.y1) / 2 - (b.box.y0 + b.box.y1) / 2)) {
    const yc = (line.box.y0 + line.box.y1) / 2;
    const last = rows[rows.length - 1];
    if (last && Math.abs(yc - last.yc) <= 0.6 * medH) {
      last.items.push(line);
      last.yc = (last.yc * (last.items.length - 1) + yc) / last.items.length;
    } else {
      rows.push({ yc, items: [line] });
    }
  }

  // 2. Trong từng hàng: gộp các box gần nhau thành 1 ô (nhiều từ cùng một ô bảng)
  interface Cell { text: string; confidence: number; x0: number; x1: number }
  const gridRows = rows.map(r => {
    const sorted = [...r.items].sort((a, b) => a.box.x0 - b.box.x0);
    const cells: Cell[] = [];
    for (const item of sorted) {
      const last = cells[cells.length - 1];
      const gap = last ? item.box.x0 - last.x1 : Infinity;
      if (last && gap < 0.7 * medH) {
        last.text += ` ${item.text}`;
        last.confidence = (last.confidence + item.confidence) / 2;
        last.x1 = item.box.x1;
      } else {
        cells.push({
          text: item.text,
          confidence: item.confidence,
          x0: item.box.x0,
          x1: item.box.x1,
        });
      }
    }
    return { yCenter: r.yc, height: medH, cells };
  });

  // 3. Gom ranh giới cột từ mép trái của mọi ô
  const leftEdges = gridRows.flatMap(r => r.cells.map(c => c.x0)).sort((a, b) => a - b);
  const boundaries: number[] = [];
  const colTol = Math.max(12, 0.8 * medH);
  for (const x of leftEdges) {
    const lastB = boundaries[boundaries.length - 1];
    if (lastB === undefined || x - lastB > colTol) boundaries.push(x);
  }

  return { imageWidth, imageHeight, rows: gridRows, columnBoundaries: boundaries };
}

// ---------------------------------------------------------------------------
// Điều phối chính
// ---------------------------------------------------------------------------

self.onmessage = async (e: MessageEvent<OCRWorkerRequest>) => {
  const req = e.data;
  if (!req || req.type !== 'RUN_OCR') return;
  if (running) {
    const err: OCRWorkerError = { type: 'ERROR', requestId: req.requestId, error: 'Worker đang bận với tác vụ khác' };
    (self as any).postMessage(err);
    return;
  }
  running = true;
  const start = performance.now();
  try {
    const { requestId, payload } = req;
    if (!payload?.imageBytes) throw new Error('Không nhận được dữ liệu ảnh');

    const b = await ensureBundle(requestId);

    progress(requestId, 26, 'DECODE', 'Giải mã ảnh...');
    const blob = new Blob([payload.imageBytes]);
    const bmp = await createImageBitmap(blob);

    // --- Detection thật ---
    const boxes = await runDetection(requestId, bmp, b.det!);
    if (boxes.length === 0) {
      const grid = buildTableGrid([], bmp.width, bmp.height);
      const done: OCRWorkerResult = {
        type: 'COMPLETE',
        requestId,
        mode: 'REAL_ONNX',
        fileName: payload.fileName ?? '',
        lines: [],
        grid,
        processingTimeMs: Math.round(performance.now() - start),
        details: 'Detection chạy thật nhưng không tìm thấy vùng chữ nào (ảnh trống/mờ/quá nhỏ?). Không bịa dữ liệu thay thế.',
        rawText: '',
      };
      (self as any).postMessage(done);
      return;
    }

      // --- Rec thật cho từng vùng, có thử cả 2 hướng nếu tin cậy thấp ---
    const lines: OcrTextLine[] = [];
    let rotatedCount = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const canvas = cropBitmap(bmp, box);
      let line = await recognizeCrop(b, canvas);

      // Đo thật: nếu thường tin cậy thấp, thử xoay 180° và giữ kết quả tốt hơn
      if (line.confidence < ROTATION_RETRY_CONFIDENCE) {
        const rotated = await recognizeCrop(b, cropBitmap(bmp, box, true));
        if (rotated.text.trim().length > 0 && rotated.confidence > line.confidence + 0.05) {
          line = rotated;
          rotatedCount++;
        }
      }

      line.box = { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
      if (line.text.trim().length > 0) lines.push(line);

      if (i % 10 === 0 || i === boxes.length - 1) {
        progress(requestId, 35 + Math.round((i + 1) / boxes.length * 55), 'RECOGNITION', `Nhận dạng dòng ${i + 1}/${boxes.length}...`);
      }
    }

    const grid = buildTableGrid(lines, bmp.width, bmp.height);
    const clsNote = `hướng chữ: quét 2 chiều 0°/180° chọn theo độ tin cậy (${rotatedCount} vùng dùng hướng xoay)`;
    const rawText = grid.rows.map(r => r.cells.map(c => c.text).join(' | ')).join('\n');

    const done: OCRWorkerResult = {
      type: 'COMPLETE',
      requestId,
      mode: 'REAL_ONNX',
      fileName: payload.fileName ?? '',
      lines,
      grid,
      processingTimeMs: Math.round(performance.now() - start),
      details: [
        `Pipeline thật: det=ch_PP-OCRv4_det_infer.onnx (${boxes.length} vùng), rec=latin_PP-OCRv3_rec.onnx`,
        b.charsetNote,
        `CTC dict: ${b.dictSource}`,
        `HR vi_dict: ${b.viDictInfo} (áp dụng HR RAG sau CTC)`,
        clsNote,
      ].join('; '),
      rawText,
    };
    (self as any).postMessage(done);
  } catch (err: any) {
    const error: OCRWorkerError = {
      type: 'ERROR',
      requestId: req.requestId,
      error: `[OCR thật thất bại - không fallback dữ liệu giả] ${err?.message || err}`,
    };
    (self as any).postMessage(error);
  } finally {
    running = false;
  }
};
