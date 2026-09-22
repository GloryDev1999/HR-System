import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseTimesheetFile } from '../services/timesheet-parser-service';
import { normalizeHeaderText, detectHeaderRow, describeColMap } from '../services/timesheet-parser-core';

function toBuffer(aoa: any[][], sheet = 'ChamCong'): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

describe('normalizeHeaderText: bỏ dấu, thường hóa', () => {
  it.each([
    ['Mã NV.', 'ma nv'],
    ['Giờ Vào', 'gio vao'],
    ['Ngày', 'ngay'],
    ['HỌ VÀ TÊN', 'ho va ten'],
    ['Trễ (phút)', 'tre phut'],
    ['  Check   In  ', 'check in'],
    ['Mã chấm công / ERP', 'ma cham cong erp'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeHeaderText(raw)).toBe(expected);
  });
});

describe('detectHeaderRow: chấm điểm + giải tranh chấp', () => {
  it('Tăng ca → otHours, Ca làm việc → shift (không nuốt token ca)', () => {
    const res = detectHeaderRow([['MSNV', 'Tăng ca', 'Ca làm việc', 'Ngày']]);
    expect(res).not.toBeNull();
    expect(res!.colMap.empId).toBe(0);
    expect(res!.colMap.otHours).toBe(1);
    expect(res!.colMap.shift).toBe(2);
    expect(res!.colMap.date).toBe(3);
  });

  it('Ngày công → workUnits (không nhầm thành Ngày)', () => {
    const res = detectHeaderRow([['Mã NV', 'Ngày', 'Ngày công']]);
    expect(res!.colMap.date).toBe(1);
    expect(res!.colMap.workUnits).toBe(2);
  });

  it('thiếu Mã NV hoặc Ngày → null để caller báo lỗi rõ', () => {
    expect(detectHeaderRow([['STT', 'Tên', 'Giờ vào']])).toBeNull();
    expect(detectHeaderRow([['Mã NV', 'Họ tên']])).toBeNull();
  });

  it('describeColMap tóm tắt đúng', () => {
    const res = detectHeaderRow([['Ngày', 'MSNV', 'Giờ check-in', 'Giờ check-out']]);
    const s = describeColMap(res!.colMap);
    expect(s).toContain('Mã NV→B');
    expect(s).toContain('Ngày→A');
    expect(s).toContain('Giờ vào→C');
    expect(s).toContain('Giờ ra→D');
  });
});

describe('parseTimesheetFile: tiêu đề đảo cột + alias + dòng tiêu đề thừa', () => {
  it('đảo thứ tự cột, alias MSNV/check-in, 2 dòng tiêu đề công ty phía trên', async () => {
    const buf = toBuffer([
      ['CÔNG TY TNHH LEGGETT & PLATT'],
      ['BẢNG CHẤM CÔNG THÁNG 08/2026'],
      ['Ngày', 'MSNV', 'Tăng ca', 'Họ tên', 'Ca làm việc', 'Giờ check-in', 'Giờ check-out', 'Ghi chú kiểm tra', 'Đi trễ', 'Về sớm', 'Phòng ban', 'Thứ'],
      ['2026-08-01', 'LEP010', 1.5, 'Nguyen Van A', 'Ca 1', '07:30', '16:00', 'ok', 0, 0, 'Production', 'T7'],
      ['2026-08-02', 'LEP010', 0, 'Nguyen Van A', 'Ca 1', '07:45', '16:00', 'ok', 15, 0, 'Production', 'CN'],
    ]);
    const result = await parseTimesheetFile(buf, 8, 2026, () => {});
    expect(result.type).toBe('COMPLETE');
    expect(result.timesheetCellsCount).toBe(2);

    const d1 = result.timesheets.find(t => t.date === '2026-08-01');
    expect(d1).toBeDefined();
    expect(d1.employeeId).toBe('LEP010');
    expect(d1.checkIn).toBe('07:30');
    expect(d1.checkOut).toBe('16:00');
    expect(d1.statusCode).toBe('W');

    // Cột Tăng ca đi đúng overtime (không rơi vào shift/ca)
    const ot = result.overtimes.find(o => o.date === '2026-08-01');
    expect(ot).toBeDefined();
    expect(ot.hours).toBe(1.5);

    // Cột "Ghi chú kiểm tra" KHÔNG bị nuốt thành giờ ra (bẫy substring "ra")
    expect(d1.checkOut).not.toBe('ok');

    // Đi trễ 15p ngày CN vẫn LA theo luật parser (không phụ thuộc thứ tự cột)
    const d2 = result.timesheets.find(t => t.date === '2026-08-02');
    expect(d2.statusCode).toBe('LA');
  });

  it('ngày DD/MM/YYYY + giờ dạng số thập phân Excel', async () => {
    const buf = toBuffer([
      ['Mã chấm công', 'Ngày', 'Giờ vào', 'Giờ ra'],
      ['LEP020', '01/08/2026', 0.3125, 0.6667],
    ]);
    const result = await parseTimesheetFile(buf, 8, 2026, () => {});
    const d = result.timesheets[0];
    expect(d.employeeId).toBe('LEP020');
    expect(d.date).toBe('2026-08-01');
    expect(d.checkIn).toBe('07:30');
    expect(d.checkOut).toBe('16:00');
  });

  it('thiếu cột Mã NV/Ngày → lỗi nêu rõ tiêu đề tìm thấy', async () => {
    const buf = toBuffer([
      ['STT', 'Tên', 'Giờ vào'],
      [1, 'Ai đó', '07:30'],
    ]);
    await expect(parseTimesheetFile(buf, 8, 2026, () => {})).rejects.toThrow(/Mã NV/);
  });

  it('cột thừa không dùng bị bỏ qua, cột thiếu (optional) mặc định 0', async () => {
    const buf = toBuffer([
      ['Employee ID', 'Date', 'Time In', 'Time Out', 'Shift', 'Note'],
      ['LEP030', '2026-08-03', '14:00', '22:00', 'Ca 2', 'x'],
    ]);
    const result = await parseTimesheetFile(buf, 8, 2026, () => {});
    expect(result.timesheetCellsCount).toBe(1);
    const d = result.timesheets[0];
    expect(d.checkIn).toBe('14:00');
    expect(d.statusCode).toBe('N');
  });
});
