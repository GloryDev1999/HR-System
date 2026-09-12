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
 * Chạy trực tiếp 100% qua In-Memory Engine với cơ chế non-blocking async ticks.
 * - Loại bỏ vĩnh viễn lỗi Web Worker (origin null trên file://, chặn blob: URL bởi Falcon EDR).
 * - Xử lý cực nhanh (~300ms cho 20.000 dòng quẹt thẻ), nhả luồng qua setTimeout(0)
 *   giúp thanh tiến trình hiển thị mượt mà không làm đơ giao diện.
 */
export async function parseTimesheetFile(
  buffer: ArrayBuffer,
  month: number,
  year: number,
  onProgress: (progress: number, message: string) => void
): Promise<ParseCompleteMessage> {
  return parseTimesheetInMemory(buffer, month, year, onProgress);
}

