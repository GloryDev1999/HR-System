import {
  parseTimesheetInMemory,
  ParseProgressMessage,
  ParseErrorMessage,
  parseExcelDate,
  parseExcelTime
} from '../services/timesheet-parser-core';

export { parseExcelDate, parseExcelTime };

self.onmessage = async (e: MessageEvent<{ buffer: ArrayBuffer; month: number; year: number }>) => {
  try {
    const { buffer, month = 8, year = 2026 } = e.data;
    
    const result = await parseTimesheetInMemory(buffer, month, year, (progress, message) => {
      self.postMessage({
        type: 'PROGRESS',
        progress,
        message
      } as ParseProgressMessage);
    });

    self.postMessage(result);
  } catch (err: any) {
    self.postMessage({
      type: 'ERROR',
      error: err.message || 'Lỗi không xác định khi xử lý tệp Excel.'
    } as ParseErrorMessage);
  }
};
