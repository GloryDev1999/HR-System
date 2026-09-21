import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseTimesheetFile } from '../services/timesheet-parser-service';

describe('Modal Nạp Dữ Liệu Chấm Công (Timesheet Excel Import)', () => {
  it('nạp tệp Excel chấm công thành công 100% không bị lỗi Web Worker', async () => {
    // 1. Giả lập bảng dữ liệu Excel chấm công chuẩn thực tế (sheet XuatLuoi)
    const header = [
      'STT', 'Mã NV', 'Họ và Tên', 'Phòng ban', 'Ngày', 'Thứ',
      'Giờ vào', 'Giờ ra', 'Trễ (phút)', 'Sớm (phút)', 'Công', 'Tổng giờ', 'Tăng ca', 'Ca'
    ];

    const sampleRows = [
      header,
      [1, 'LEP001', 'Nguyen Van A', 'Sản Xuất', '2026-08-01', 'T7', '07:25', '16:05', 0, 0, 1, 8, 0, 'Ca 1'],
      [2, 'LEP001', 'Nguyen Van A', 'Sản Xuất', '2026-08-02', 'CN', '07:30', '16:30', 0, 0, 0, 8, 8, 'Ca 1'],
      [3, 'LEP002', 'Tran Thi B', 'Kho', '2026-08-01', 'T7', '07:45', '16:00', 15, 0, 1, 7.75, 0, 'Ca 1'],
      [4, 'LEP003', 'Le Van C', 'QC', '2026-08-01', 'T7', '', '16:00', 0, 0, 0, 0, 0, 'Ca 1'],
    ];

    const ws = XLSX.utils.aoa_to_sheet(sampleRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'XuatLuoi');

    // Xuất ra ArrayBuffer giả lập như file người dùng upload
    const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const progressLogs: { progress: number; message: string }[] = [];
    const onProgress = (progress: number, message: string) => {
      progressLogs.push({ progress, message });
    };

    // 2. Thực thi nạp file
    const result = await parseTimesheetFile(buffer, 8, 2026, onProgress);

    // 3. Khẳng định kết quả
    expect(result.type).toBe('COMPLETE');
    expect(result.rawLogsCount).toBe(4);
    expect(result.timesheetCellsCount).toBe(4);
    expect(progressLogs.length).toBeGreaterThan(0);

    // Kiểm tra chi tiết dòng quẹt thẻ
    const log1 = result.rawLogs.find(l => l.employeeId === 'LEP001' && l.date === '2026-08-01');
    expect(log1).toBeDefined();
    expect(log1.checkIn).toBe('07:25');
    expect(log1.checkOut).toBe('16:05');

    // Kiểm tra dòng trễ 15p của LEP002 (LA)
    const ts2 = result.timesheets.find(t => t.employeeId === 'LEP002');
    expect(ts2).toBeDefined();
    expect(ts2.statusCode).toBe('LA');

    // Kiểm tra dòng thiếu giờ vào của LEP003 (MCO)
    const ts3 = result.timesheets.find(t => t.employeeId === 'LEP003');
    expect(ts3).toBeDefined();
    expect(ts3.statusCode).toBe('MCO');
  });

  it('xử lý an toàn khi tệp Excel rỗng hoặc định dạng không hợp lệ', async () => {
    const emptyBuffer = new ArrayBuffer(0);
    await expect(parseTimesheetFile(emptyBuffer, 8, 2026, () => {})).rejects.toThrow();
  });
});
