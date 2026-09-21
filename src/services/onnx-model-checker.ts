/**
 * Health check ONNX - kiểm tra THẬT các thành phần OCR cục bộ.
 *
 * Offline 100%: không tải bất kỳ script CDN nào. Runtime ORT đã được bundle
 * trong worker (onnx-ocr.worker.ts import 'onnxruntime-web/wasm') hoặc chạy
 * trực tiếp main-thread (ocr-engine-direct.ts) nên checker chỉ cần xác minh:
 * WebAssembly + SIMD, file model tồn tại (kèm kích thước thật từ
 * Content-Length hoặc IndexedDB), từ điển ký tự (đếm dòng + dấu tiếng Việt).
 *
 * Chạy được cả 2 chế độ:
 *  - http://localhost: model lấy qua fetch() đường dẫn TƯƠNG ĐỐI
 *    (không dùng '/' tuyệt đối để sống được sub-path lẫn file://).
 *  - file:// (mở trực tiếp trong thư mục OneDrive HR-System): fetch bị chặn
 *    nên kiểm tra kho IndexedDB (user nạp 1 lần qua "Nạp model offline").
 * Dùng GET thay HEAD vì nhiều static host/CDN chặn HEAD gây báo WARNING giả.
 */

import { getOcrAsset, getStoredOcrAssetKeys, isFileProtocol } from './ocr-assets-store';

export interface IONNXModelHealthReport {
  status: 'READY' | 'WARNING' | 'ERROR';
  mode: 'REAL_ONNX';
  wasmEngine: {
    name: 'ONNX Runtime Web (bundled trong worker)';
    simdSupported: boolean;
    threads: number;
    webgpuSupported: boolean;
  };
  models: {
    name: string;
    path: string;
    loaded: boolean;
    sizeFormatted: string; // kích thước thật đo từ Content-Length hoặc IndexedDB
    description: string;
  }[];
  dictionary: {
    path: string;
    charCount: number; // số dòng thật của latin_dict.txt (CTC dict chính, output 187)
    vietnameseDiacritics: boolean; // phát hiện ký tự tiếng Việt thật trong dict
  };
  /** HR Vietnamese comprehensive dict (vi_dict.txt, 235 ký tự) - dùng cho RAG post-process */
  viDictionary?: {
    path: string;
    charCount: number;
    vietnameseDiacritics: boolean;
    isComprehensive: boolean; // 235 = latin 185 + 50 HR Vietnamese
    statusNote: string;
  };
  /** Thời gian thực hiện toàn bộ bước kiểm tra (ms) - đo thật */
  checkDurationMs: number;
  timestamp: string;
  /** Giao thức trang đang chạy: file = mở trực tiếp offline, http = qua localhost/server */
  protocol?: 'file' | 'http';
  /** Nguồn model thực tế: server (fetch từ hosting/Storage) | idb (kho offline) | mixed | missing */
  assetSource?: 'server' | 'idb' | 'mixed' | 'missing';
  /** true khi đang file:// mà kho offline còn thiếu -> UI hiện nút "Nạp model offline" */
  needsOfflineAssets?: boolean;
}

/** Model cần cho pipeline thật — ĐƯỜNG DẪN TƯƠNG ĐỐI (sống được file:// + sub-path) */
const MODEL_SPECS = [
  {
    key: 'det',
    assetKey: 'det' as const,
    name: 'PP-OCRv4 Text Detection (DBNet)',
    path: './PaddleOCR-Models/onnx/ch_PP-OCRv4_det_infer.onnx',
    desc: 'Phát hiện vùng chữ trên ảnh phiếu tăng ca',
  },
  {
    key: 'rec-latin',
    assetKey: 'rec' as const,
    name: 'PP-OCRv3 Latin Recognition',
    path: './PaddleOCR-Models/onnx/latin_PP-OCRv3_rec.onnx',
    desc: 'Nhận dạng ký tự Latin & tiếng Việt đa dấu (CTC decode)',
  },
];

const DICT_PATH = './PaddleOCR-Models/dictionaries/latin_dict.txt';
const DICT_PATH_VI = './PaddleOCR-Models/dictionaries/vi_dict.txt';
const ORT_WASM_PATH = './PaddleOCR-Models/ort/ort-wasm-simd-threaded.wasm';

/**
 * Dò SIMD + Threads thực tế trên Edge/Chrome.
 * Trả về true nếu browser thật sự hỗ trợ WASM SIMD (v128).
 * Giữ logic validate nhưng thêm fallback cho Edge: nếu validate fail do module biên dịch cũ,
 * thử module SIMD chuẩn thứ 2.
 */
function detectSimd(): boolean {
  try {
    // Module 1: minimal v128 type (dùng cho hầu hết Chromium)
    const simdModule1 = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x0a, 0x01, 0x08, 0x00,
      0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    if (WebAssembly.validate(simdModule1)) return true;
    // Module 2: fallback với v128.load (phổ biến trên Edge)
    const simdModule2 = new Uint8Array([
      0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,0x01,0x05,0x01,0x60,0x00,0x01,0x7b,0x03,0x02,0x01,0x00,0x0a,0x0e,0x01,0x0c,0x00,0x41,0x00,0xfd,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x0b
    ]);
    return WebAssembly.validate(simdModule2);
  } catch {
    return false;
  }
}

function detectThreads(): number {
  try {
    const c = (navigator as unknown as { hardwareConcurrency?: number }).hardwareConcurrency || 1;
    // Threads cần crossOriginIsolated + SharedArrayBuffer, nhưng vẫn báo số lõi để hiển thị tăng tốc
    return c;
  } catch { return 1; }
}

/**
 * Kiểm tra file tồn tại + lấy kích thước mà KHÔNG tải cả file:
 * GET rồi đọc header Content-Length, hủy body ngay (HEAD hay bị chặn).
 * Trên file:// fetch ném lỗi -> { exists: false } (sẽ bù bằng IndexedDB).
 */
async function probeFile(url: string): Promise<{ exists: boolean; size?: number }> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* ignore */ }
      return { exists: false };
    }
    const len = res.headers.get('content-length');
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return { exists: true, size: len ? parseInt(len, 10) : undefined };
  } catch {
    return { exists: false };
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return 'không xác định';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countDictLines(text: string): string[] {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export async function testONNXModelRuntime(): Promise<IONNXModelHealthReport> {
  const startTime = performance.now();
  const fileMode = isFileProtocol();

  const hasWasm = typeof WebAssembly === 'object';
  const simdSupported = hasWasm && detectSimd();
  const webgpuSupported = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const threads = detectThreads();
  // Tăng tốc thực tế: nếu Edge đang chạy bản mới, SIMD thường đã hỗ trợ; nếu detect fail do module cũ, vẫn coi là hỗ trợ khi threads>2 và WebAssembly có
  // Tự động tối ưu: nếu hasWasm && threads>=2 thì coi tăng tốc khả dụng (phản ánh đúng tốc độ, và sẽ áp dụng cache + threads ở worker)

  // Kho offline IndexedDB (nguồn chính trên file://)
  const storedKeys = await getStoredOcrAssetKeys();
  const idbSizeOf = async (key: 'det' | 'rec' | 'latin_dict' | 'vi_dict' | 'ort-wasm'): Promise<number | undefined> => {
    const row = await getOcrAsset(key);
    return row && row.bytes.byteLength > 0 ? row.bytes.byteLength : undefined;
  };

  // 1) Model files + runtime wasm: fetch tương đối + bù IndexedDB
  const [detProbe, recProbe, ortProbe] = await Promise.all([
    probeFile(MODEL_SPECS[0].path),
    probeFile(MODEL_SPECS[1].path),
    probeFile(ORT_WASM_PATH),
  ]);
  const [detIdb, recIdb, ortIdb] = await Promise.all([
    idbSizeOf('det'), idbSizeOf('rec'), idbSizeOf('ort-wasm'),
  ]);
  // Cloud-only: model từ hosting/Storage (fetch) + bù kho IndexedDB. Không còn bản nhúng base64.
  const detOk = detProbe.exists || detIdb !== undefined;
  const recOk = recProbe.exists || recIdb !== undefined;
  const ortOk = ortProbe.exists || ortIdb !== undefined;
  const detSize = detProbe.size ?? detIdb;
  const recSize = recProbe.size ?? recIdb;

  const modelResults = [
    { spec: MODEL_SPECS[0], ok: detOk, size: detSize, viaIdb: !detProbe.exists && detIdb !== undefined },
    { spec: MODEL_SPECS[1], ok: recOk, size: recSize, viaIdb: !recProbe.exists && recIdb !== undefined },
  ];

  // 2) Từ điển latin: fetch tương đối, thiếu thì bù IndexedDB
  let dictExists = false;
  let dictCharCount = 0;
  let hasVietnamese = false;
  let dictViaIdb = false;
  const dictText = await fetchText(DICT_PATH);
  if (dictText !== null) {
    dictExists = true;
    const lines = countDictLines(dictText);
    dictCharCount = lines.length;
    const charset = new Set(lines.join('').split(''));
    hasVietnamese = ['ệ', 'ơ', 'ư', 'đ', 'ậ'].every(c => charset.has(c));
    // latin_dict 185 không chứa đủ 50 ký tự HR (ă, ơ, ư...), nên hasVietnamese sẽ false -> expected
    // Đó là lý do vi_dict comprehensive 235 tồn tại để HR RAG bổ sung
  } else {
    const idbText = await getOcrAsset('latin_dict');
    if (idbText && idbText.bytes.byteLength > 0) {
      dictExists = true;
      dictViaIdb = true;
      const lines = countDictLines(new TextDecoder('utf-8').decode(idbText.bytes));
      dictCharCount = lines.length;
      const charset = new Set(lines.join('').split(''));
      hasVietnamese = ['ệ', 'ơ', 'ư', 'đ', 'ậ'].every(c => charset.has(c));
    }
  }

  // 2b) vi_dict comprehensive (HR) - không ảnh hưởng coreReady của pipeline CTC (vẫn dùng latin)
  let viDictCount = 0;
  let viHasVietnamese = false;
  let viIsComprehensive = false;
  let viStatusNote = '';
  let viExists = false;
  const viText = await fetchText(DICT_PATH_VI);
  const analyseVi = (text: string) => {
    viExists = true;
    const lines = countDictLines(text);
    viDictCount = lines.length;
    const charset = new Set(lines.join('').split(''));
    viHasVietnamese = ['ệ', 'ơ', 'ư', 'đ', 'ậ', 'ă', 'ị', 'ỹ'].every(c => charset.has(c));
    viIsComprehensive = viDictCount === 235;
    if (viDictCount === 113) {
      viStatusNote = 'BẢN LỖI CŨ 113 ký tự (thiếu digits/symbols, đã fix thành 235) - worker hiện fallback về latin nên vẫn chạy';
    } else if (viIsComprehensive) {
      viStatusNote = 'Comprehensive HR Vietnamese (latin 185 + 50 ký tự HR) - dùng cho HR RAG post-process, CTC vẫn dùng latin 185 khớp model 187';
    } else if (viDictCount === 185) {
      viStatusNote = 'Copy của latin_dict (khớp model) - OK';
    } else {
      viStatusNote = `Kích thước ${viDictCount}, kiểm tra lại mapping với model`;
    }
  };
  if (viText !== null) {
    analyseVi(viText);
  } else {
    const viIdb = await getOcrAsset('vi_dict');
    if (viIdb && viIdb.bytes.byteLength > 0) {
      analyseVi(new TextDecoder('utf-8').decode(viIdb.bytes));
      viStatusNote += ' (từ kho offline)';
    } else {
      viStatusNote = 'không tìm thấy (không bắt buộc)';
    }
  }

  // 3) Trạng thái tổng hợp
  // coreReady chỉ phụ thuộc latin_dict (CTC) + models + wasm. vi_dict là HR bổ sung, không làm fail pipeline.
  // Tăng tốc không phải điều kiện bắt buộc cho READY, chỉ là chỉ số hiệu năng
  const coreReady = hasWasm && detOk && recOk && ortOk && dictExists;
  const status: IONNXModelHealthReport['status'] =
    !hasWasm ? 'ERROR'
      : coreReady ? 'READY'
        : 'WARNING';

  const viaIdbCount = modelResults.filter(m => m.viaIdb).length + (dictViaIdb ? 1 : 0);
  const viaServerCount = modelResults.filter(m => !m.viaIdb && m.ok).length + (!dictViaIdb && dictExists ? 1 : 0);
  const assetSource: IONNXModelHealthReport['assetSource'] =
    viaIdbCount > 0 && viaServerCount > 0 ? 'mixed'
      : viaIdbCount > 0 ? 'idb'
        : viaServerCount > 0 ? 'server'
          : 'missing';

  const missing: string[] = [];
  if (!detOk) missing.push('det model');
  if (!recOk) missing.push('rec model');
  if (!ortOk) missing.push('ort-wasm runtime');
  if (!dictExists) missing.push('latin dictionary');

  return {
    status,
    mode: 'REAL_ONNX',
    wasmEngine: {
      name: 'ONNX Runtime Web (bundled trong worker)',
      simdSupported,
      threads,
      webgpuSupported,
    },
    models: modelResults.map(({ spec, ok, size, viaIdb }) => ({
      name: spec.name,
      path: spec.path,
      loaded: ok,
      sizeFormatted: formatSize(size),
      description: `${spec.desc} — ${ok ? `File sẵn sàng${viaIdb ? ' (kho offline)' : ' (hosting/Storage)'}` : 'KHÔNG tìm thấy'}`,
    })),
    dictionary: {
      path: DICT_PATH,
      charCount: dictCharCount,
      vietnameseDiacritics: hasVietnamese,
    },
    viDictionary: viExists ? {
      path: DICT_PATH_VI,
      charCount: viDictCount,
      vietnameseDiacritics: viHasVietnamese,
      isComprehensive: viIsComprehensive,
      statusNote: viStatusNote,
    } : undefined,
    checkDurationMs: Math.round(performance.now() - startTime),
    timestamp: new Date().toLocaleString('vi-VN'),
    protocol: fileMode ? 'file' : 'http',
    assetSource,
    needsOfflineAssets: fileMode && !coreReady,
  };
}
