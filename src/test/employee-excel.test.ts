import { describe, it, expect, vi } from 'vitest';
import * as XLSX from 'xlsx';
import {
  parseEmployeeExcel,
  EMPLOYEE_TEMPLATE_HEADERS,
  downloadEmployeeTemplate,
} from '../services/employee-excel';

function toBuffer(aoa: any[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'NhanVien');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

const LINES = [
  { id: 'line_rivet_1', name: 'Line Rivet 1' },
  { id: 'line_rivet_2', name: 'Line Rivet 2' },
];

const FULL_ROW = [
  'LEP010', '1013789', 'Nguyen Van A', 'Production', 'Operator', '01/08/2026',
  'Chính thức', 'T2-T7', 'Đang làm việc', 'Line Rivet 1', 1,
  '1 năm', '01/08/2026', '01/08/2027', 2, '01/10/2026',
  100000, 200000, 500000, 1000000, 12,
];

describe('employee-excel: mẫu + parse', () => {
  it('mẫu đủ 21 cột, có cột bắt buộc', () => {
    expect(EMPLOYEE_TEMPLATE_HEADERS).toHaveLength(21);
    expect(EMPLOYEE_TEMPLATE_HEADERS[0]).toContain('Mã NV');
    expect(EMPLOYEE_TEMPLATE_HEADERS[2]).toContain('Họ và tên');
  });

  it('parse dòng full tiếng Việt đúng hết field', () => {
    const buf = toBuffer([EMPLOYEE_TEMPLATE_HEADERS, FULL_ROW]);
    const { employees, errors } = parseEmployeeExcel(buf, LINES);
    expect(errors).toEqual([]);
    expect(employees).toHaveLength(1);
    const e = employees[0];
    expect(e.employeeId).toBe('LEP010');
    expect(e.erpId).toBe('1013789');
    expect(e.contractType).toBe('OFFICIAL');
    expect(e.shiftClassId).toBe('OFFICE_M_S');
    expect(e.status).toBe('ACTIVE');
    expect(e.productionLine).toBe('line_rivet_1');
    expect(e.productivityGroup).toBe(1);
    expect(e.contractTerm).toBe('1_YEAR');
    expect(e.contractStartDate).toBe('01/08/2026');
    expect(e.contractEndDate).toBe('01/08/2027');
    expect(e.probationMonths).toBe(2);
    expect(e.probationEndDate).toBe('01/10/2026');
    expect(e.customAllowances.pcccAllowance).toBe(100000);
    expect(e.customAllowances.diligenceBonus).toBe(500000);
    expect(e.customAllowances.tradeUnionFee).toBe(-40000);
    expect(e.annualLeaveBalance.initialQuota).toBe(12);
    expect(e.annualLeaveBalance.remainingDays).toBe(12);
  });

  it('dòng tối thiểu → mặc định hệ thống', () => {
    const buf = toBuffer([EMPLOYEE_TEMPLATE_HEADERS, ['LEP011', '', 'Tran Thi B']]);
    const { employees, errors } = parseEmployeeExcel(buf, LINES);
    expect(errors).toEqual([]);
    const e = employees[0];
    expect(e.department).toBe('Production');
    expect(e.position).toBe('Operator');
    expect(e.contractType).toBe('OFFICIAL');
    expect(e.shiftClassId).toBe('OFFICE_M_S');
    expect(e.status).toBe('ACTIVE');
    expect(e.startDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(e.productionLine).toBeUndefined();
  });

  it('mã ca/line theo code + số tiền nghìn + ngày ISO', () => {
    const row = ['LEP012', '', 'Le Van C', 'WH', '', '2026-09-01', 'SEASONAL', 'SHIFT_1', '', '', '', '', '', '', '', '', '', '500.000', '', '', ''];
    const buf = toBuffer([EMPLOYEE_TEMPLATE_HEADERS, row]);
    const { employees, errors } = parseEmployeeExcel(buf, LINES);
    expect(errors).toEqual([]);
    const e = employees[0];
    expect(e.contractType).toBe('SEASONAL');
    expect(e.shiftClassId).toBe('SHIFT_1');
    expect(e.startDate).toBe('01/09/2026');
    expect(e.customAllowances.hazardousAllowance).toBe(500000);
  });

  it('báo lỗi từng dòng: thiếu tên, ca sai, Line lạ, trùng mã', () => {
    const buf = toBuffer([
      EMPLOYEE_TEMPLATE_HEADERS,
      ['LEP020', '', ''],
      ['LEP021', '', 'A', '', '', '', '', 'Ca 9'],
      ['LEP022', '', 'B', '', '', '', '', '', '', 'Line X'],
      ['LEP023', '', 'C'],
      ['LEP023', '', 'C2'],
    ]);
    const { employees, errors } = parseEmployeeExcel(buf, LINES);
    expect(employees.map(e => e.employeeId)).toEqual(['LEP023']);
    expect(errors).toHaveLength(4);
    expect(errors[0].row).toBe(2);
    expect(errors[1].message).toContain('Nhóm ca');
    expect(errors[2].message).toContain('Line');
    expect(errors[3].message).toContain('trùng lặp');
  });

  it('thiếu cột Mã NV/Họ tên → lỗi rõ', () => {
    const buf = toBuffer([[['STT', 'Ghi chú'], [1, 'x']][0], [1, 'x']]);
    expect(() => parseEmployeeExcel(buf, LINES)).toThrow(/Mã NV/);
  });

  it('downloadEmployeeTemplate tạo file (jsdom Blob)', async () => {
    const clicks: string[] = [];
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, ...rest: any[]) => {
      const el = (origCreate as any)(tag, ...rest);
      if (tag === 'a') {
        el.click = () => clicks.push(el.download);
      }
      return el;
    }) as any);
    await downloadEmployeeTemplate();
    expect(clicks).toEqual(['Mau_Them_Nhan_Vien.xlsx']);
    vi.restoreAllMocks();
  });
});
