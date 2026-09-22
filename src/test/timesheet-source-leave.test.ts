import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseTimesheetFile } from '../services/timesheet-parser-service';
import { detectHeaderRow } from '../services/timesheet-parser-core';

function toBuffer(aoa: any[][], sheet = 'XuatLuoi'): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

/** Fixture mô phỏng file máy chấm công trong ảnh: header chẻ 2 dòng, ngày M/D/YYYY */
const SOURCE_HEADER_2ROW = [
  ['STT', 'Mã', 'Điền', 'Điền', 'Điền', 'Điền', 'Điền', 'Điền', 'Điền', 'CT', 'CT', 'Điền', 'C'],
  ['STT', 'Nhân Viên', 'Tên nhân viên', 'BỘ PHẬN/Department', 'VỊ TRÍ CÔNG VIỆC/Position', 'Ngày', 'Thứ', 'Giờ vào', 'Giờ ra', 'HÀNH CHÍNH', 'TĂNG CA', 'NGÀY NGHỈ PHÉP', 'PHÉP'],
];

describe('file nguồn máy chấm công (2 dòng header, M/D/YYYY, cột phép)', () => {
  it('nhận diện đủ cột từ header ghép', () => {
    const res = detectHeaderRow(SOURCE_HEADER_2ROW);
    expect(res).not.toBeNull();
    expect(res!.headerRowIndex).toBe(1);
    expect(res!.colMap.empId).toBe(1);
    expect(res!.colMap.date).toBe(5);
    expect(res!.colMap.checkIn).toBe(7);
    expect(res!.colMap.checkOut).toBe(8);
    expect(res!.colMap.totalHours).toBe(9);
    expect(res!.colMap.otHours).toBe(10);
    expect(res!.colMap.leaveDate).toBe(11);
    expect(res!.colMap.leaveCode).toBe(12);
  });

  it('parse đầy đủ: ngày M/D, punch đơn, AL/PH, OT nguồn', async () => {
    const buf = toBuffer([
      ...SOURCE_HEADER_2ROW,
      ['1', 'LEP004', 'LE THANH HUNG EHS', 'EHS', 'EHS Engineer', '8/24/2026', 'Hai', '7:32', '16:07', 8, '', '', ''],
      ['2', 'LEP004', 'LE THANH HUNG EHS', 'EHS', 'EHS Engineer', '8/23/2026', 'CN', '', '', '', '', '', ''],
      // Punch đơn 16:00 dồn ở cột Giờ vào (thiếu vào → MCI ở tầng parser; Header so ca để chốt)
      ['3', 'LEP004', 'LE THANH HUNG EHS', 'EHS', 'EHS Engineer', '8/25/2026', 'Ba', '16:00', '', '', '', '', ''],
      // Nghỉ AL theo cột phép nguồn
      ['4', 'LEP004', 'LE THANH HUNG EHS', 'EHS', 'EHS Engineer', '8/31/2026', 'Hai', '', '', '', '', '8/31/2026', 'AL'],
      // Nghỉ lễ PH: chốt mã, không sinh yêu cầu quota
      ['5', 'LEP004', 'LE THANH HUNG EHS', 'EHS', 'EHS Engineer', '9/1/2026', 'Ba', '', '', '', '', '9/1/2026', 'PH'],
      // OT nguồn 2.5h
      ['6', 'LEP007', 'Phan Thi Hai Au', 'Finance', 'Accountant', '8/21/2026', 'Sáu', '7:32', '18:45', 8, 2.5, '', ''],
    ]);
    const result = await parseTimesheetFile(buf, 8, 2026, () => {});
    expect(result.type).toBe('COMPLETE');

    // 8/21/2026 (M/D) → 2026-08-21, không phải tháng 21
    const ot = result.overtimes.find(o => o.employeeId === 'LEP007');
    expect(ot).toBeDefined();
    expect(ot.date).toBe('2026-08-21');
    expect(ot.hours).toBe(2.5);

    // 8/24/2026 → W đủ
    const w = result.timesheets.find(t => t.employeeId === 'LEP004' && t.date === '2026-08-24');
    expect(w).toBeDefined();
    expect(w.statusCode).toBe('W');
    expect(w.checkIn).toBe('07:32');

    // CN không quẹt → rỗng
    const cn = result.timesheets.find(t => t.date === '2026-08-23');
    expect(cn.statusCode).toBe('');

    // Punch đơn 16:00 ở cột vào → MCI tầng parser
    const single = result.timesheets.find(t => t.date === '2026-08-25');
    expect(single.checkIn).toBe('16:00');
    expect(single.checkOut).toBe('');
    expect(single.statusCode).toBe('MCI');

    // AL nguồn → ô AL + 1 yêu cầu PENDING
    const al = result.timesheets.find(t => t.date === '2026-08-31');
    expect(al.statusCode).toBe('AL');
    expect(result.leaves).toHaveLength(1);
    expect(result.leaves[0].id).toBe('LEAVE_LEP004_2026-08-31');
    expect(result.leaves[0].status).toBe('PENDING');
    expect(result.leaves[0].leaveType).toBe('AL');
    expect(result.leaves[0].missedHours).toBe(8);

    // PH nguồn (9/1/2026 M/D → 2026-09-01) → ô PH, không sinh yêu cầu
    const ph = result.timesheets.find(t => t.date === '2026-09-01');
    expect(ph.statusCode).toBe('PH');
    expect(result.leaves).toHaveLength(1);
  });
});
