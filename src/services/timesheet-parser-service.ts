import TimesheetParserWorker from '../workers/timesheet-parser.worker.ts?worker&inline';
import { isFileProtocol } from './ocr-assets-store';
import {
  parseTimesheetInMemory,
  ParseCompleteMessage,
  ParseProgressMessage,
  ParseErrorMessage,
  parseExcelDate,
  parseExcelTime
} from './timesheet-parser-core';

export type { ParseCompleteMessage, ParseProgressMessage, ParseErrorMessage };
export { parseExcelDate, parseExcelTime, parseTimesheetInMemory };

/**
 * Điều phối xử lý phân tích file chấm công:
 * - Trên offline file:// (OneDrive mở trực tiếp): Chạy trực tiếp qua In-Memory Engine
 *   (loại bỏ 100% lỗi Web Worker bị chặn origin 'null').
 * - Trên HTTP/localhost: Dùng Web Worker, nếu có bất kỳ trục trặc nào sẽ tự động
 *   rơi về In-Memory an toàn tuyệt đối, không ném lỗi "Lỗi Web Worker".
 */
export async function parseTimesheetFile(
  buffer: ArrayBuffer,
  month: number,
  year: number,
  onProgress: (progress: number, message: string) => void
): Promise<ParseCompleteMessage> {
  // 1. Nếu chạy qua giao thức file://, bỏ qua Web Worker để tránh lỗi origin null
  if (isFileProtocol()) {
    return parseTimesheetInMemory(buffer, month, year, onProgress);
  }

  // 2. Chạy qua Web Worker với cơ chế Fallback tự động
  return new Promise<ParseCompleteMessage>((resolve, reject) => {
    let worker: Worker | null = null;
    try {
      worker = new TimesheetParserWorker() as unknown as Worker;
    } catch {
      // Khởi tạo worker thất bại -> rơi về In-Memory
      return parseTimesheetInMemory(buffer, month, year, onProgress).then(resolve, reject);
    }

    let isFinished = false;

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'PROGRESS') {
        onProgress(msg.progress, msg.message);
      } else if (msg.type === 'COMPLETE') {
        isFinished = true;
        try { worker?.terminate(); } catch {}
        resolve(msg as ParseCompleteMessage);
      } else if (msg.type === 'ERROR') {
        isFinished = true;
        try { worker?.terminate(); } catch {}
        // Fallback về In-Memory
        parseTimesheetInMemory(buffer, month, year, onProgress).then(resolve, reject);
      }
    };

    worker.onerror = () => {
      if (isFinished) return;
      isFinished = true;
      try { worker?.terminate(); } catch {}
      // Tự động rơi về In-Memory khi worker gặp sự cố
      parseTimesheetInMemory(buffer, month, year, onProgress).then(resolve, reject);
    };

    worker.postMessage({ buffer, month, year });
  });
}
