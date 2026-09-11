/**
 * OCR Worker Client - Promise-based wrapper cho onnx-ocr.worker.ts,
 * tự rơi về engine trực tiếp (main thread) khi Worker không dùng được.
 *
 * Điểm quan trọng:
 *  - Mỗi lần chạy có requestId riêng -> progress/kết quả không bị trộn giữa các lần gọi
 *  - Các lần gọi được xếp hàng tuần tự (worker chỉ xử lý 1 ảnh tại một thời điểm)
 *  - terminateOcrWorker() huỷ worker và từ chối mọi tác vụ đang chờ
 *  - Worker được bundle INLINE (`?worker&inline`, update-model.md §2) nên chạy được
 *    cả file:// (double-click dist/index.html trong OneDrive) lẫn http://localhost.
 *    Model/wasm lấy từ bản nhúng base64 trong worker, không fetch file rời.
 *    Chỉ khi worker inline cũng lỗi mới rơi về ocr-engine-direct.ts
 *    (đọc model từ kho IndexedDB offline).
 *  - Chỉ worker này chứa bản nhúng 35MB. Main thread KHÔNG import
 *    EMBEDDED_MODELS để tránh nhân đôi bundle.
 */
import OcrWorker from '../workers/onnx-ocr.worker.ts?worker&inline';
import type {
  OCRWorkerRequest,
  OCRWorkerProgress,
  OCRWorkerResult,
  OCRWorkerError,
} from '../types/ocr-worker-protocol';
import { runOcrDirect } from './ocr-engine-direct';
import { isFileProtocol } from './ocr-assets-store';

export interface OcrRunHandlers {
  onProgress?: (progress: number, step: string, message: string) => void;
}

export interface OcrRunOptions extends OcrRunHandlers {
  fileName?: string;
  /** Ép chạy trực tiếp không qua Worker (mặc định tự quyết theo giao thức). */
  forceDirect?: boolean;
}

export type { OCRWorkerResult as OcrRunResult };

let workerInstance: Worker | null = null;
/** Worker đã xác định là hỏng trong phiên này -> bỏ qua, đi thẳng direct. */
let workerBroken = false;

/** Hàng đợi tuần tự: mỗi phần tử là continuation của cái trước */
let queueTail: Promise<unknown> = Promise.resolve();

/** Các tác vụ đang chờ — terminate sẽ reject toàn bộ (tránh treo vĩnh viễn). */
const pendingRejects = new Set<(err: Error) => void>();

function getWorker(): Worker {
  if (!workerInstance) {
    // Inline worker (base64 trong bundle) — chạy được cả file:// lẫn http.
    workerInstance = new OcrWorker() as unknown as Worker;
  }
  return workerInstance;
}

function runOnce(imageBytes: ArrayBuffer, options: OcrRunOptions): Promise<OCRWorkerResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = getWorker();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const requestId = `ocr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    pendingRejects.add(reject);

    const onMessage = (e: MessageEvent) => {
      const msg = e.data;
      if (!msg || msg.requestId !== requestId) return; // tin nhắn của lần chạy khác - bỏ qua

      switch (msg.type) {
        case 'PROGRESS':
          options.onProgress?.((msg as OCRWorkerProgress).progress, (msg as OCRWorkerProgress).step, (msg as OCRWorkerProgress).message);
          break;
        case 'COMPLETE':
          cleanup();
          resolve(msg as OCRWorkerResult);
          break;
        case 'ERROR':
          cleanup();
          reject(new Error((msg as OCRWorkerError).error));
          break;
      }
    };
    const onError = (e: ErrorEvent) => {
      cleanup();
      // Worker crash (điển hình trên file://) -> đánh dấu hỏng để lần sau đi direct luôn.
      workerBroken = true;
      reject(new Error(e.message || 'OCR Worker crashed'));
    };
    function cleanup() {
      pendingRejects.delete(reject);
      try {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      } catch { /* ignore */ }
    }

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);

    const request: OCRWorkerRequest = {
      type: 'RUN_OCR',
      requestId,
      payload: { imageBytes, fileName: options.fileName, isFileProtocol: isFileProtocol() },
    };
    try {
      worker.postMessage(request, [imageBytes]); // transferable - tránh copy bộ nhớ
    } catch (err) {
      cleanup();
      workerBroken = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Chạy pipeline trực tiếp main-thread, bọc kết quả về đúng OCRWorkerResult. */
async function runDirectAsWorkerResult(
  imageBytes: ArrayBuffer,
  options: OcrRunOptions,
): Promise<OCRWorkerResult> {
  const started = Date.now();
  const direct = await runOcrDirect(imageBytes, {
    fileName: options.fileName,
    onProgress: options.onProgress,
  });
  return {
    type: 'COMPLETE',
    requestId: `direct_${started}_${Math.random().toString(36).slice(2, 8)}`,
    mode: 'REAL_ONNX',
    fileName: direct.fileName,
    lines: direct.lines,
    grid: direct.grid,
    processingTimeMs: direct.processingTimeMs,
    details: `${direct.details} [chạy trực tiếp main-thread, không Worker]`,
    rawText: direct.rawText,
  };
}

/**
 * Chạy pipeline OCR thật trên một ảnh. Các lời gọi chồng nhau được xếp hàng,
 * kết quả luôn gắn đúng requestId của lần gọi.
 * Ưu tiên worker inline (có model nhúng, chạy được cả file://); chỉ rơi về
 * direct khi worker hỏng/crash giữa chừng.
 */
export function runOcrPipeline(
  imageBlob: Blob | ArrayBuffer,
  options: OcrRunOptions = {}
): Promise<OCRWorkerResult> {
  const job = async (): Promise<ArrayBuffer> =>
    imageBlob instanceof ArrayBuffer ? imageBlob : await imageBlob.arrayBuffer();

  // Xếp hàng tuần tự để worker/direct engine không bao giờ nhận 2 tác vụ cùng lúc
  const run = queueTail.then(() => job()).then(async (bytes) => {
    const wantDirect = options.forceDirect || workerBroken;
    if (wantDirect) {
      return runDirectAsWorkerResult(bytes, options);
    }
    try {
      // Giữ 1 bản copy: postMessage transfer sẽ detach buffer gốc, nếu worker
      // lỗi giữa chừng vẫn còn bản copy để fallback direct.
      const backup = bytes.slice(0);
      try {
        return await runOnce(bytes, options);
      } catch (workerErr) {
        workerBroken = true;
        return await runDirectAsWorkerResult(backup, options);
      }
    } catch (err) {
      throw err;
    }
  });
  // Nếu 1 job lỗi vẫn phải tiếp tục hàng đợi cho các job sau
  queueTail = run.catch(() => undefined);
  return run;
}

export function terminateOcrWorker() {
  try {
    workerInstance?.terminate();
  } catch { /* ignore */ }
  workerInstance = null;
  if (pendingRejects.size > 0) {
    const err = new Error('OCR Worker đã bị huỷ (terminateOcrWorker)');
    const rejects = Array.from(pendingRejects);
    pendingRejects.clear();
    rejects.forEach(reject => {
      try { reject(err); } catch { /* ignore */ }
    });
  }
}
