/**
 * OCR Engine Direct — pipeline PaddleOCR THẬT chạy trên MAIN THREAD, không qua Worker.
 *
 * Dùng khi mở dist/index.html trực tiếp bằng file:// trong thư mục OneDrive
 * (C:\...\HR-System): Web Worker module riêng file không khởi tạo được và
 * fetch() tương đối bị chặn, nên Worker không thể dùng. Engine này:
 *   1. Ưu tiên đọc model từ IndexedDB (do user nạp 1 lần qua "Nạp model offline"),
 *   2. Rơi về fetch() tương đối (khi chạy http://localhost vẫn như Worker),
 *   3. Tuyệt đối không bịa kết quả — thiếu model là báo lỗi rõ ràng.
 *
 * Logic inference (DBNet det + CTC rec + dựng lưới) tương đương
 * src/workers/onnx-ocr.worker.ts, chỉ khác lớp tải tài nguyên và canvas
 * (dùng <canvas> của document thay vì OffscreenCanvas trong Worker).
 */
import * as ort from 'onnxruntime-web/wasm';
import type { OcrTextLine, OcrTableGrid } from '../types/ocr-worker-protocol';
import {
  getOcrAsset,
  isFileProtocol,
  type OcrAssetKey,
} from './ocr-assets-store';

export interface OcrDirectProgress {
  onProgress?: (progress: number, step: string, message: string) => void;
  fileName?: string;
}

export interface OcrDirectResult {
  mode: 'REAL_ONNX_DIRECT';
  fileName: string;
  lines: OcrTextLine[];
  grid: OcrTableGrid;
  processingTimeMs: number;
  details: string;
  rawText: string;
}

// --- Hằng số pipeline (đồng bộ với onnx-ocr.worker.ts) ---
const DET_LIMIT_SIDE = 960;
const DET_BIN_THRESH = 0.3;
const DET_BOX_SCORE = 0.5;
const DET_UNCLIP_RATIO = 1.6;
const REC_TARGET_H = 48;
const MAX_BOXES = 400;
const ROTATION_RETRY_CONFIDENCE = 0.25;

// Đường dẫn tương đối (KHÔNG dùng '/' tuyệt đối để sống được cả file://
// lẫn deploy sub-path). Thứ tự ưu tiên: IndexedDB -> fetch tương đối.
const REL_DET = 'PaddleOCR-Models/onnx/ch_PP-OCRv4_det_infer.onnx';
const REL_REC = 'PaddleOCR-Models/onnx/latin_PP-OCRv3_rec.onnx';
const REL_LATIN_DICT = 'PaddleOCR-Models/dictionaries/latin_dict.txt';
const REL_VI_DICT = 'PaddleOCR-Models/dictionaries/vi_dict.txt';

function getCandidateUrls(relPath: string): string[] {
  const clean = relPath.replace(/^\.?\//, '');
  const list: string[] = [];
  try {
    const base = typeof document !== 'undefined' ? document.baseURI : './';
    list.push(new URL(clean, base).href);
    list.push(new URL('../' + clean, base).href);
    list.push(new URL('../../' + clean, base).href);
  } catch { /* ignore */ }
  list.push('./' + clean);
  list.push(clean);
  return Array.from(new Set(list));
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.arrayBuffer();
}

/** Đọc model: IndexedDB trước, fetch tương đối sau. */
async function loadBufferWithIdbFallback(relPath: string, assetKey: OcrAssetKey): Promise<ArrayBuffer> {
  const stored = await getOcrAsset(assetKey);
  if (stored && stored.bytes.byteLength > 0) return stored.bytes.slice(0);
  let lastError: unknown = null;
  for (const url of getCandidateUrls(relPath)) {
    try {
      const buf = await fetchBuffer(url);
      if (buf.byteLength > 0) return buf;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Không nạp được ${relPath} (đã thử bộ nhớ offline + đường dẫn tương đối). ` +
    `Trên file:// hãy bấm "Nạp model offline" để chọn file model 1 lần. Lỗi: ${(lastError as Error)?.message || lastError}`
  );
}

async function loadTextWithIdbFallback(relPath: string, assetKey: OcrAssetKey): Promise<string> {
  const stored = await getOcrAsset(assetKey);
  if (stored && stored.bytes.byteLength > 0) return new TextDecoder('utf-8').decode(stored.bytes);
  let lastError: unknown = null;
  for (const url of getCandidateUrls(relPath)) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 0) return text;
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Không nạp được từ điển ${relPath}. Lỗi: ${(lastError as Error)?.message || lastError}`);
}

/**
 * Trên file://, ORT vẫn fetch file .wasm runtime qua mạng nội bộ trang nên sẽ
 * thất bại. Nếu user đã nạp ort-wasm vào IndexedDB, vá tạm global fetch trong
 * lúc tạo session để phục vụ đúng file đó (fetch Blob -> Response hợp lệ).
 * dynamic import() không đi qua fetch nên cấu hình proxy=false để ORT không
 * cần nạp file .mjs runtime (glue đã bundle sẵn trong main thread).
 */
async function withIdbWasmFetch<T>(fn: () => Promise<T>): Promise<T> {
  const wasmRow = await getOcrAsset('ort-wasm');
  const mjsRow = await getOcrAsset('ort-mjs');
  if ((!wasmRow || wasmRow.bytes.byteLength === 0) && (!mjsRow || mjsRow.bytes.byteLength === 0)) {
    return fn();
  }
  const origFetch = globalThis.fetch.bind(globalThis);
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url || String(input);
      if (wasmRow && wasmRow.bytes.byteLength > 0 && url.endsWith('ort-wasm-simd-threaded.wasm')) {
        return new Response(wasmRow.bytes.slice(0), { headers: { 'Content-Type': 'application/wasm' } });
      }
      if (mjsRow && mjsRow.bytes.byteLength > 0 && url.endsWith('ort-wasm-simd-threaded.mjs')) {
        return new Response(mjsRow.bytes.slice(0), { headers: { 'Content-Type': 'text/javascript' } });
      }
    } catch { /* rơi về fetch gốc */ }
    return origFetch(input as RequestInfo, init);
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = patched as typeof fetch;
  try {
    return await fn();
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = origFetch;
  }
}

// --- Session bundle (lazy, tái dùng giữa các lần quét) ---
interface SessionBundle {
  det?: ort.InferenceSession;
  rec?: ort.InferenceSession;
  charset: string[];
  dictSize: number;
  charsetNote: string;
  dictSource: string;
  viDictInfo: string;
}

let bundle: SessionBundle | null = null;
let wasmConfigured = false;

function configureWasm() {
  if (wasmConfigured) return;
  wasmConfigured = true;
  const fileMode = isFileProtocol();
  try {
    if (!fileMode) {
      const dir = new URL('PaddleOCR-Models/ort/', document.baseURI).href;
      ort.env.wasm.wasmPaths = dir.endsWith('/') ? dir : dir + '/';
    } else {
      // Trên file://, TUYỆT ĐỐI không đặt wasmPaths trỏ đường dẫn file://
      // vì Chromium sẽ gọi dynamic import() tải file .mjs gây lỗi "Failed to fetch dynamically imported module"
      delete (ort.env.wasm as any).wasmPaths;
    }
  } catch {
    if (!fileMode) ort.env.wasm.wasmPaths = './PaddleOCR-Models/ort/';
  }
  try {
    const hasSAB = typeof SharedArrayBuffer !== 'undefined';
    const hw = (navigator as Navigator & { hardwareConcurrency?: number }).hardwareConcurrency || 4;
    // file:// hoặc môi trường không có SharedArrayBuffer thì 1 luồng, ngược lại dùng tối đa 4 luồng
    (ort.env.wasm as unknown as Record<string, unknown>).numThreads = (hasSAB && !fileMode) ? Math.min(hw, 4) : 1;
    (ort.env.wasm as unknown as Record<string, unknown>).simd = true;
    (ort.env.wasm as unknown as Record<string, unknown>).proxy = false;
  } catch { /* ignore */ }
}

function parseDictText(text: string): string[] {
  const dict = text.split('\n').map(l => l.replace(/\r$/, ''));
  while (dict.length > 0 && dict[dict.length - 1] === '') dict.pop();
  return dict;
}

async function ensureBundle(onProgress: OcrDirectProgress['onProgress']): Promise<SessionBundle> {
  if (bundle) return bundle;
  configureWasm();
  onProgress?.(8, 'INIT_WASM', 'Khởi tạo thuật toán OCR trực tiếp (không Worker)...');

  const latinText = await loadTextWithIdbFallback(REL_LATIN_DICT, 'latin_dict');
  const latinDict = parseDictText(latinText);
  if (latinDict.length !== 185 && latinDict.length !== 186) {
    console.warn(`[OCR Direct] latin_dict size bất thường: ${latinDict.length}, kỳ vọng 185.`);
  }
  let viInfo = 'không tải được vi_dict';
  try {
    const viText = await loadTextWithIdbFallback(REL_VI_DICT, 'vi_dict');
    const viDict = parseDictText(viText);
    viInfo = `vi_dict ${viDict.length} ký tự`;
  } catch {
    viInfo = 'vi_dict lỗi (không bắt buộc)';
  }
  const wasmRow = await getOcrAsset('ort-wasm');
  if (wasmRow && wasmRow.bytes.byteLength > 0) {
    ort.env.wasm.wasmBinary = wasmRow.bytes;
    delete (ort.env.wasm as any).wasmPaths;
  }

  onProgress?.(12, 'LOAD_DET', 'Đang tải mô hình phát hiện vùng chữ...');
  const detBuf = await loadBufferWithIdbFallback(REL_DET, 'det');
  const det = await withIdbWasmFetch(() => ort.InferenceSession.create(detBuf, { executionProviders: ['wasm'] }));

  onProgress?.(20, 'LOAD_REC', 'Đang tải mô hình nhận dạng ký tự...');
  const recBuf = await loadBufferWithIdbFallback(REL_REC, 'rec');
  const rec = await withIdbWasmFetch(() => ort.InferenceSession.create(recBuf, { executionProviders: ['wasm'] }));

  bundle = {
    det, rec,
    charset: ['blank', ...latinDict],
    dictSize: latinDict.length,
    charsetNote: '',
    dictSource: `latin_dict.txt (${latinDict.length} chars)`,
    viDictInfo: viInfo,
  };
  return bundle;
}

// --- Canvas helpers trên main thread ---
function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function bitmapToNormalizedTensor(
  src: ImageBitmap | HTMLCanvasElement,
  dstW: number,
  dstH: number,
  mean: number[],
  std: number[],
): { tensor: ort.Tensor; scale: number } {
  const scale = Math.min(dstW / src.width, dstH / src.height);
  const drawW = Math.max(1, Math.round(src.width * scale));
  const drawH = Math.max(1, Math.round(src.height * scale));
  const canvas = makeCanvas(dstW, dstH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, dstW, dstH);
  ctx.drawImage(src, 0, 0, drawW, drawH);
  const img = ctx.getImageData(0, 0, dstW, dstH).data;
  const plane = dstW * dstH;
  const data = new Float32Array(3 * plane);
  for (let i = 0, px = 0; i < plane; i++, px += 4) {
    data[i] = ((img[px] / 255) - mean[0]) / std[0];
    data[plane + i] = ((img[px + 1] / 255) - mean[1]) / std[1];
    data[2 * plane + i] = ((img[px + 2] / 255) - mean[2]) / std[2];
  }
  return { tensor: new ort.Tensor('float32', data, [1, 3, dstH, dstW]), scale };
}

function cropToCanvas(
  bmp: ImageBitmap,
  box: { x0: number; y0: number; x1: number; y1: number },
  rotate180 = false,
): HTMLCanvasElement {
  const w = Math.max(1, Math.round(box.x1 - box.x0));
  const h = Math.max(1, Math.round(box.y1 - box.y0));
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (rotate180) {
    ctx.translate(w, h);
    ctx.rotate(Math.PI);
  }
  ctx.drawImage(bmp, box.x0, box.y0, w, h, 0, 0, w, h);
  return canvas;
}

function canvasToNormalizedCHW(canvas: HTMLCanvasElement, mean = 0.5, std = 0.5): ort.Tensor {
  const w = canvas.width;
  const h = canvas.height;
  const img = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const plane = w * h;
  const data = new Float32Array(3 * plane);
  for (let i = 0, px = 0; i < plane; i++, px += 4) {
    data[i] = ((img[px] / 255) - mean) / std;
    data[plane + i] = ((img[px + 1] / 255) - mean) / std;
    data[2 * plane + i] = ((img[px + 2] / 255) - mean) / std;
  }
  return new ort.Tensor('float32', data, [1, 3, h, w]);
}

function roundToMultipleOf32(v: number): number {
  return Math.max(32, Math.ceil(v / 32) * 32);
}

interface RawBox { x0: number; y0: number; x1: number; y1: number }

async function runDetection(
  onProgress: OcrDirectProgress['onProgress'],
  bmp: ImageBitmap,
  det: ort.InferenceSession,
): Promise<RawBox[]> {
  const rawScale = Math.min(1, DET_LIMIT_SIDE / Math.max(bmp.width, bmp.height));
  const scaledW = roundToMultipleOf32(bmp.width * rawScale);
  const scaledH = roundToMultipleOf32(bmp.height * rawScale);
  const { tensor, scale } = bitmapToNormalizedTensor(
    bmp, scaledW, scaledH,
    [0.485, 0.456, 0.406],
    [0.229, 0.224, 0.225],
  );
  onProgress?.(30, 'DETECTION', `Chạy detection DBNet trên ảnh ${bmp.width}×${bmp.height}px (tensor ${scaledW}×${scaledH})...`);
  const feeds: Record<string, ort.Tensor> = {};
  feeds[det.inputNames[0]] = tensor;
  const out = await det.run(feeds);
  const probMap = out[det.outputNames[0]];
  const dims = probMap.dims as number[];
  const pH = dims[dims.length - 2];
  const pW = dims[dims.length - 1];
  return dbNetBoxesFromProbMap(probMap.data as Float32Array, pH, pW, scale);
}

function dbNetBoxesFromProbMap(probs: Float32Array, pH: number, pW: number, scale: number): RawBox[] {
  const visited = new Uint8Array(pH * pW);
  const stack = new Int32Array(pH * pW);
  const boxes: RawBox[] = [];
  for (let start = 0; start < probs.length; start++) {
    if (probs[start] < DET_BIN_THRESH || visited[start]) continue;
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
      if (y > 0 && !visited[idx - pW] && probs[idx - pW] >= DET_BIN_THRESH) { visited[idx - pW] = 1; stack[sp++] = idx - pW; }
      if (y < pH - 1 && !visited[idx + pW] && probs[idx + pW] >= DET_BIN_THRESH) { visited[idx + pW] = 1; stack[sp++] = idx + pW; }
      if (x > 0 && !visited[idx - 1] && probs[idx - 1] >= DET_BIN_THRESH) { visited[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (x < pW - 1 && !visited[idx + 1] && probs[idx + 1] >= DET_BIN_THRESH) { visited[idx + 1] = 1; stack[sp++] = idx + 1; }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (count < 10 || bw < 2 || bh < 2) continue;
    if (probSum / count < DET_BOX_SCORE) continue;
    const d = (DET_UNCLIP_RATIO * count) / (2 * (bw + bh));
    boxes.push({
      x0: Math.max(0, (minX - d) / scale),
      y0: Math.max(0, (minY - d) / scale),
      x1: (maxX + 1 + d) / scale,
      y1: (maxY + 1 + d) / scale,
    });
  }
  boxes.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
  return boxes.slice(0, MAX_BOXES);
}

function noteCharsetSize(b: SessionBundle, modelC: number): string {
  if (b.charsetNote) return b.charsetNote;
  if (modelC === b.dictSize + 1) {
    b.charsetNote = `output rec C=${modelC} khớp blank + ${b.dictSize} ký tự dict`;
  } else if (modelC === b.dictSize + 2) {
    b.charsetNote = `output rec C=${modelC} khớp blank + ${b.dictSize} ký tự dict + khoảng trắng`;
  } else {
    b.charsetNote = `CẢNH BÁO lệch từ điển: model output C=${modelC}, dict ${b.dictSize} ký tự`;
  }
  return b.charsetNote;
}

function softmaxAt(logits: Float32Array, base: number, C: number, at: number): number {
  let maxV = -Infinity;
  for (let ci = 0; ci < C; ci++) if (logits[base + ci] > maxV) maxV = logits[base + ci];
  let sum = 0;
  for (let ci = 0; ci < C; ci++) sum += Math.exp(logits[base + ci] - maxV);
  return Math.exp(logits[base + at] - maxV) / sum;
}

async function recognizeCrop(b: SessionBundle, canvas: HTMLCanvasElement): Promise<OcrTextLine> {
  const targetW = Math.max(8, Math.min(640, Math.round((canvas.width * REC_TARGET_H) / canvas.height)));
  const resized = makeCanvas(targetW, REC_TARGET_H);
  const rctx = resized.getContext('2d', { willReadFrequently: true })!;
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
  void charsetNote;
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
      text += charset[best];
      confSum += softmaxAt(logits, base, C, best);
      confCount++;
    }
    prev = best;
  }
  return { text, confidence: confCount > 0 ? confSum / confCount : 0, box: { x0: 0, y0: 0, x1: 0, y1: 0 } };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function buildTableGrid(lines: OcrTextLine[], imageWidth: number, imageHeight: number): OcrTableGrid {
  const heights = lines.map(l => l.box.y1 - l.box.y0);
  const medH = Math.max(8, median(heights));
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
        cells.push({ text: item.text, confidence: item.confidence, x0: item.box.x0, x1: item.box.x1 });
      }
    }
    return { yCenter: r.yc, height: medH, cells };
  });
  const leftEdges = gridRows.flatMap(r => r.cells.map(c => c.x0)).sort((a, b) => a - b);
  const boundaries: number[] = [];
  const colTol = Math.max(12, 0.8 * medH);
  for (const x of leftEdges) {
    const lastB = boundaries[boundaries.length - 1];
    if (lastB === undefined || x - lastB > colTol) boundaries.push(x);
  }
  return { imageWidth, imageHeight, rows: gridRows, columnBoundaries: boundaries };
}

/** Chạy pipeline OCR trực tiếp trên main thread (không Worker). */
export async function runOcrDirect(
  imageBytes: ArrayBuffer,
  options: OcrDirectProgress = {},
): Promise<OcrDirectResult> {
  const start = performance.now();
  const onProgress = options.onProgress;
  const b = await ensureBundle(onProgress);
  onProgress?.(26, 'DECODE', 'Giải mã ảnh...');
  const blob = new Blob([imageBytes]);
  const bmp = await createImageBitmap(blob);

  const boxes = await runDetection(onProgress, bmp, b.det!);
  if (boxes.length === 0) {
    const grid = buildTableGrid([], bmp.width, bmp.height);
    return {
      mode: 'REAL_ONNX_DIRECT',
      fileName: options.fileName ?? '',
      lines: [],
      grid,
      processingTimeMs: Math.round(performance.now() - start),
      details: 'Detection chạy thật (trực tiếp, không Worker) nhưng không tìm thấy vùng chữ nào. Không bịa dữ liệu thay thế.',
      rawText: '',
    };
  }

  const lines: OcrTextLine[] = [];
  let rotatedCount = 0;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    let line = await recognizeCrop(b, cropToCanvas(bmp, box));
    // Tối ưu tốc độ: chỉ thử xoay 180° nếu độ tin cậy quá thấp (< 0.25)
    // VÀ chưa nhận diện được chữ/số rõ ràng (tránh nhân đôi thời gian suy luận vô ích)
    const hasMeaningful = /[A-Za-z0-9]{2,}/.test(line.text);
    if (line.confidence < ROTATION_RETRY_CONFIDENCE && !hasMeaningful) {
      const rotated = await recognizeCrop(b, cropToCanvas(bmp, box, true));
      if (rotated.text.trim().length > 0 && rotated.confidence > line.confidence + 0.1) {
        line = rotated;
        rotatedCount++;
      }
    }
    line.box = { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
    if (line.text.trim().length > 0) lines.push(line);
    if (i % 10 === 0 || i === boxes.length - 1) {
      onProgress?.(35 + Math.round(((i + 1) / boxes.length) * 55), 'RECOGNITION', `Nhận dạng dòng ${i + 1}/${boxes.length}...`);
    }
  }

  const grid = buildTableGrid(lines, bmp.width, bmp.height);
  try { bmp.close(); } catch { /* ignore */ }
  return {
    mode: 'REAL_ONNX_DIRECT',
    fileName: options.fileName ?? '',
    lines,
    grid,
    processingTimeMs: Math.round(performance.now() - start),
    details: [
      `Pipeline thật trực tiếp (không Worker): det=ch_PP-OCRv4_det_infer.onnx (${boxes.length} vùng), rec=latin_PP-OCRv3_rec.onnx`,
      b.charsetNote,
      `CTC dict: ${b.dictSource}`,
      `HR vi_dict: ${b.viDictInfo}`,
      `hướng chữ: quét 2 chiều 0°/180° (${rotatedCount} vùng dùng hướng xoay)`,
    ].join('; '),
    rawText: grid.rows.map(r => r.cells.map(c => c.text).join(' | ')).join('\n'),
  };
}
