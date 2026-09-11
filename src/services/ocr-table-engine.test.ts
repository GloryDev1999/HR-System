import { describe, it, expect } from 'vitest';
import {
  normalizeEmployeeCode,
  normalizeDateString,
  parseOvertimeHours,
  mapGridToTableRows,
} from './ocr-table-engine';
import { extractCanonicalHRKey } from './hr-rag-postprocessor';
import { IEmployee, IOvertimeRecord } from '../types';
import { reconcileRows, IExtractedFormRow } from './ocr-form-parser';
import { OcrTextLine } from '../types/ocr-worker-protocol';

const catalog: IEmployee[] = [
  {
    employeeId: 'LEP010',
    erpId: '1013789',
    fullName: 'Trịnh Đình Tâm',
    department: 'WH',
    position: 'Lead',
    startDate: '01/01/2022',
    contractType: 'OFFICIAL',
    shiftClassId: 'SHIFT_1',
    customAllowances: { pcccAllowance: 0, hazardousAllowance: 0, diligenceBonus: 500000, productivityBonus: 0, tradeUnionFee: -40000, otherFees: 0 },
    annualLeaveBalance: { initialQuota: 12, usedDays: 0, remainingDays: 12 },
    status: 'ACTIVE'
  },
  {
    employeeId: 'LEP026',
    erpId: '1013790',
    fullName: 'Nguyễn Bá Trình',
    department: 'WH',
    position: 'Operator',
    startDate: '01/01/2022',
    contractType: 'SEASONAL',
    shiftClassId: 'SHIFT_2',
    customAllowances: { pcccAllowance: 0, hazardousAllowance: 0, diligenceBonus: 500000, productivityBonus: 0, tradeUnionFee: -40000, otherFees: 0 },
    annualLeaveBalance: { initialQuota: 12, usedDays: 0, remainingDays: 12 },
    status: 'ACTIVE'
  },
  {
    employeeId: 'LEP066A',
    erpId: '1013799',
    fullName: 'Lê Văn An',
    department: 'Production',
    position: 'Operator',
    startDate: '01/01/2022',
    contractType: 'OFFICIAL',
    shiftClassId: 'SHIFT_1',
    customAllowances: { pcccAllowance: 0, hazardousAllowance: 0, diligenceBonus: 500000, productivityBonus: 0, tradeUnionFee: -40000, otherFees: 0 },
    annualLeaveBalance: { initialQuota: 12, usedDays: 0, remainingDays: 12 },
    status: 'ACTIVE'
  }
];

describe('normalizeEmployeeCode', () => {
  it('direct match LEP026', () => {
    const res = normalizeEmployeeCode('LEP026', catalog);
    expect(res.normalizedId).toBe('LEP026');
    expect(res.matched).toBe(true);
  });
  it('pads LEP10 -> LEP010 via fuzzy', () => {
    const res = normalizeEmployeeCode('LEP10', catalog);
    expect(res.normalizedId).toBe('LEP010');
    expect(res.matched).toBe(true);
  });
  it('handles LP variant', () => {
    const res = normalizeEmployeeCode('LP026', catalog);
    expect(res.normalizedId).toBe('LEP026');
  });
  it('handles O->0 typo chỉ trong phần số sau tiền tố (LEPO26)', () => {
    const res = normalizeEmployeeCode('LEP O26', catalog);
    expect(res.normalizedId).toBe('LEP026');
    expect(res.matched).toBe(true);
  });
  it('không phá mã chứa chữ O thật ngoài phần số', () => {
    // "LEP" + "O26" vẫn phải khớp nhờ thay O trong segment số,
    // nhưng mã như "MON26" không được biến thành "M0N26" rồi ghép bừa
    const res = normalizeEmployeeCode('MON26', catalog);
    expect(res.matched).toBe(false);
  });
  it('khớp mã nhân viên có hậu tố text LEP066A', () => {
    const res = normalizeEmployeeCode('LEP066A', catalog);
    expect(res.normalizedId).toBe('LEP066A');
    expect(res.matched).toBe(true);
    expect(res.name).toBe('Lê Văn An');
  });
  it('khớp mã thiếu số 0 có hậu tố: LEP66A -> LEP066A', () => {
    const res = normalizeEmployeeCode('LEP66A', catalog);
    expect(res.normalizedId).toBe('LEP066A');
    expect(res.matched).toBe(true);
    expect(res.name).toBe('Lê Văn An');
  });
  it('khớp mã nhầm chữ O có hậu tố: LEPO66A -> LEP066A', () => {
    const res = normalizeEmployeeCode('LEPO66A', catalog);
    expect(res.normalizedId).toBe('LEP066A');
    expect(res.matched).toBe(true);
  });
  it('digits only 26 -> LEP026 (chỉ khi khớp danh mục)', () => {
    const res = normalizeEmployeeCode('26', catalog);
    expect(res.normalizedId).toBe('LEP026');
    expect(res.matched).toBe(true);
  });
  it('unknown code returns not matched, không bịa tên', () => {
    const res = normalizeEmployeeCode('LEP999', catalog);
    expect(res.matched).toBe(false);
    expect(res.name).toBe('');
  });
  it('khớp mã nhân viên dính mã bộ phận: LEP026 WH -> LEP026', () => {
    const res = normalizeEmployeeCode('LEP026 WH', catalog);
    expect(res.normalizedId).toBe('LEP026');
    expect(res.matched).toBe(true);
    expect(res.name).toBe('Nguyễn Bá Trình');
    expect(res.dept).toBe('WH');
  });
  it('khớp mã nhân viên dính liền bộ phận: LEP026WH -> LEP026', () => {
    const res = normalizeEmployeeCode('LEP026WH', catalog);
    expect(res.normalizedId).toBe('LEP026');
    expect(res.matched).toBe(true);
  });
});

describe('extractCanonicalHRKey - RAG model thu gọn HR key LEP000 và LEP000A', () => {
  it('thu gọn LEP000 chuẩn', () => {
    expect(extractCanonicalHRKey('LEP001')).toBe('LEP001');
    expect(extractCanonicalHRKey('LEP1')).toBe('LEP001');
    expect(extractCanonicalHRKey('LEPOOO')).toBe('LEP000');
    expect(extractCanonicalHRKey('LEPOO1')).toBe('LEP001');
    expect(extractCanonicalHRKey('LEP040')).toBe('LEP040');
    expect(extractCanonicalHRKey('LEP40')).toBe('LEP040');
  });

  it('thu gọn LEP000A có hậu tố chữ cái đơn (ví dụ LEP066A, LEP100A, LEP170a)', () => {
    expect(extractCanonicalHRKey('LEP066A')).toBe('LEP066A');
    expect(extractCanonicalHRKey('LEP66A')).toBe('LEP066A');
    expect(extractCanonicalHRKey('LEPO66A')).toBe('LEP066A');
    expect(extractCanonicalHRKey('LP100A')).toBe('LEP100A');
    expect(extractCanonicalHRKey('LEP170a')).toBe('LEP170A');
    expect(extractCanonicalHRKey('LEP170A')).toBe('LEP170A');
  });

  it('tách bỏ mã bộ phận dính kèm (WH, QC, PROD, KHO) để giữ đúng key LEP000/LEP000A', () => {
    expect(extractCanonicalHRKey('LEP026 WH')).toBe('LEP026');
    expect(extractCanonicalHRKey('LEP026WH')).toBe('LEP026');
    expect(extractCanonicalHRKey('LEP040WH')).toBe('LEP040');
    expect(extractCanonicalHRKey('LEP170a WH')).toBe('LEP170A');
    expect(extractCanonicalHRKey('LEP170A-WH')).toBe('LEP170A');
    expect(extractCanonicalHRKey('LEP026 Kho')).toBe('LEP026');
  });

  it('trích xuất từ chuỗi dài kèm text', () => {
    expect(extractCanonicalHRKey('1 LEP010 Trịnh Đình Tâm')).toBe('LEP010');
    expect(extractCanonicalHRKey('Dòng 2: LEP066A chuyền may')).toBe('LEP066A');
  });
});

describe('normalizeDateString', () => {
  it('DD/MM/YYYY', () => {
    expect(normalizeDateString('26/07/2026').normalizedDate).toBe('2026-07-26');
    expect(normalizeDateString('26/07/2026').valid).toBe(true);
  });
  it('DD-MM-YYYY', () => {
    expect(normalizeDateString('26-07-2026').normalizedDate).toBe('2026-07-26');
  });
  it('DD.MM.YYYY', () => {
    expect(normalizeDateString('26.07.2026').normalizedDate).toBe('2026-07-26');
  });
  it('ISO YYYY-MM-DD ưu tiên trước', () => {
    expect(normalizeDateString('2026-07-26').normalizedDate).toBe('2026-07-26');
    expect(normalizeDateString('2026-07-26').valid).toBe(true);
  });
  it('invalid returns empty với valid=false - không bịa ngày mặc định', () => {
    const res = normalizeDateString('invalid');
    expect(res.valid).toBe(false);
    expect(res.normalizedDate).toBe('');
  });
  it('ngày không tồn tại (31/02/2026) -> valid=false', () => {
    expect(normalizeDateString('31/02/2026').valid).toBe(false);
  });
});

describe('parseOvertimeHours', () => {
  it('parses direct hours 8.0', () => {
    expect(parseOvertimeHours('8.0', '07:30', '16:00').hours).toBe(8.0);
  });
  it('computes from interval 07:30-16:00 = 8.0 sau trừ 30 phút trưa', () => {
    const res = parseOvertimeHours('', '07:30', '16:00');
    expect(res.computedFromTime).toBe(8.0);
    // Không có số trên phiếu -> dùng số giờ tính từ khung giờ (dữ liệu phái sinh, không phải bịa)
    expect(res.hours).toBe(8.0);
  });
  it('short interval 16:00-18:30 = 2.5', () => {
    const res = parseOvertimeHours('2.5', '16:00', '18:30');
    expect(res.hours).toBe(2.5);
    expect(res.computedFromTime).toBe(2.5);
  });
  it('comma decimal 2,5 -> 2.5', () => {
    expect(parseOvertimeHours('2,5').hours).toBe(2.5);
  });
  it('ca qua đêm 22:00->06:00 = 8h, không âm', () => {
    const res = parseOvertimeHours('', '22:00', '06:00');
    expect(res.computedFromTime).toBe(8);
  });
  it('không có gì parse được -> hours=null tuyệt đối không trả 8h mặc định', () => {
    const res = parseOvertimeHours('', '', '');
    expect(res.hours).toBeNull();
    expect(res.computedFromTime).toBeUndefined();
  });
  it('khung giờ dài 11.5h không bị ép về 8.0', () => {
    const res = parseOvertimeHours('', '06:00', '17:30'); // 690ph - 30 nghi = 660ph
    expect(res.computedFromTime).toBeCloseTo(11, 1);
  });
});

// ---------------------------------------------------------------------------
// mapGridToTableRows - tái tạo bảng theo bố cục ảnh scan
// ---------------------------------------------------------------------------

function line(text: string, x0: number, x1: number, y0: number, y1: number): OcrTextLine {
  return { text, confidence: 0.95, box: { x0, y0, x1, y1 } };
}

describe('mapGridToTableRows', () => {
  it('tìm header bằng từ khoá và gán ô vào đúng cột', () => {
    // Header: STT | Mã NV | Họ tên | Ngày | Thời gian | Số giờ
    const lines: OcrTextLine[] = [
      line('STT', 10, 40, 100, 120),
      line('Mã NV', 60, 140, 100, 120),
      line('Họ và Tên', 160, 300, 100, 120),
      line('Ngày tăng ca', 320, 430, 100, 120),
      line('Thời gian', 450, 570, 100, 120),
      line('Số giờ', 590, 680, 100, 120),

      line('1', 15, 35, 130, 150),
      line('LEP026', 70, 130, 130, 150),
      line('Nguyễn Bá Trình', 170, 290, 130, 150),
      line('26/07/2026', 330, 420, 130, 150),
      line('07:30 - 16:00', 460, 560, 130, 150),
      line('8.0', 600, 650, 130, 150),

      line('2', 15, 35, 160, 180),
      line('LEP010', 70, 130, 160, 180),
      line('Trịnh Đình Tâm', 170, 290, 160, 180),
      line('26/07/2026', 330, 420, 160, 180),
      line('16:00 - 18:30', 460, 560, 160, 180),
      line('2.5', 600, 650, 160, 180),
    ];

    const grid = {
      imageWidth: 700,
      imageHeight: 200,
      rows: [
        { yCenter: 110, height: 20, cells: [0, 1, 2, 3, 4, 5].map(i => ({ text: lines[i].text, confidence: 0.95, x0: lines[i].box.x0, x1: lines[i].box.x1 })) },
        { yCenter: 140, height: 20, cells: [6, 7, 8, 9, 10, 11].map(i => ({ text: lines[i].text, confidence: 0.95, x0: lines[i].box.x0, x1: lines[i].box.x1 })) },
        { yCenter: 170, height: 20, cells: [12, 13, 14, 15, 16, 17].map(i => ({ text: lines[i].text, confidence: 0.95, x0: lines[i].box.x0, x1: lines[i].box.x1 })) },
      ],
      columnBoundaries: [],
    };

    const rows = mapGridToTableRows(grid);
    expect(rows).toHaveLength(2);

    expect(rows[0].employeeCode).toBe('LEP026');
    expect(rows[0].fullName).toBe('Nguyễn Bá Trình');
    expect(rows[0].rawDate).toBe('26/07/2026');
    expect(rows[0].fromTime).toBe('07:30');
    expect(rows[0].toTime).toBe('16:00');
    expect(rows[0].hoursText).toBe('8.0');

    expect(rows[1].employeeCode).toBe('LEP010');
    expect(rows[1].fromTime).toBe('16:00');
    expect(rows[1].toTime).toBe('18:30');
    expect(rows[1].hoursText).toBe('2.5');
  });

  it('bảng không header: phân loại theo nội dung ô', () => {
    const grid = {
      imageWidth: 500,
      imageHeight: 120,
      rows: [
        {
          yCenter: 30,
          height: 18,
          cells: [
            { text: 'LEP026', confidence: 0.9, x0: 10, x1: 90 },
            { text: 'Nguyễn Văn A', confidence: 0.9, x0: 110, x1: 240 },
            { text: '26/07/2026', confidence: 0.9, x0: 260, x1: 360 },
            { text: '8.0', confidence: 0.9, x0: 380, x1: 420 },
          ],
        },
      ],
      columnBoundaries: [],
    };

    const rows = mapGridToTableRows(grid);
    expect(rows).toHaveLength(1);
    expect(rows[0].employeeCode).toBe('LEP026');
    expect(rows[0].fullName).toBe('Nguyễn Văn A');
    expect(rows[0].rawDate).toBe('26/07/2026');
    expect(rows[0].hoursText).toBe('8.0');
  });

  it('grid rỗng trả về mảng rỗng - không bịa dòng', () => {
    expect(mapGridToTableRows({ imageWidth: 0, imageHeight: 0, rows: [], columnBoundaries: [] })).toEqual([]);
  });

  it('bảng có tiêu đề Giờ vào, Giờ ra, Tổng giờ', () => {
    const grid = {
      imageWidth: 600,
      imageHeight: 100,
      rows: [
        {
          yCenter: 20,
          height: 18,
          cells: [
            { text: 'Mã NV', confidence: 0.95, x0: 10, x1: 90 },
            { text: 'Ngày', confidence: 0.95, x0: 100, x1: 190 },
            { text: 'Giờ vào', confidence: 0.95, x0: 200, x1: 290 },
            { text: 'Giờ ra', confidence: 0.95, x0: 300, x1: 390 },
            { text: 'Tổng giờ', confidence: 0.95, x0: 400, x1: 500 },
          ]
        },
        {
          yCenter: 50,
          height: 18,
          cells: [
            { text: 'LEP026', confidence: 0.95, x0: 10, x1: 90 },
            { text: '26/07/2026 CN', confidence: 0.95, x0: 100, x1: 190 },
            { text: '07:30', confidence: 0.95, x0: 200, x1: 290 },
            { text: '16:00', confidence: 0.95, x0: 300, x1: 390 },
            { text: '8.0h', confidence: 0.95, x0: 400, x1: 500 },
          ]
        }
      ],
      columnBoundaries: []
    };
    const rows = mapGridToTableRows(grid);
    expect(rows).toHaveLength(1);
    expect(rows[0].employeeCode).toBe('LEP026');
    expect(rows[0].rawDate).toBe('26/07/2026 CN');
    expect(rows[0].fromTime).toBe('07:30');
    expect(rows[0].toTime).toBe('16:00');
    expect(rows[0].hoursText).toBe('8.0h');
  });

  it('bảng không header chứa 2 ô giờ đơn phân tách Giờ vào và Giờ ra', () => {
    const grid = {
      imageWidth: 600,
      imageHeight: 100,
      rows: [
        {
          yCenter: 30,
          height: 18,
          cells: [
            { text: 'LEP004', confidence: 0.95, x0: 10, x1: 80 },
            { text: '21/08/2026', confidence: 0.95, x0: 100, x1: 200 },
            { text: '07:32', confidence: 0.95, x0: 220, x1: 280 },
            { text: '16:07', confidence: 0.95, x0: 300, x1: 360 },
          ]
        }
      ],
      columnBoundaries: []
    };
    const rows = mapGridToTableRows(grid);
    expect(rows).toHaveLength(1);
    expect(rows[0].employeeCode).toBe('LEP004');
    expect(rows[0].fromTime).toBe('07:32');
    expect(rows[0].toTime).toBe('16:07');
  });
});

describe('OCR Overtime Auto-Reconciliation (LEP026 ngày 26/07/2026)', () => {
  const overtimesDb: IOvertimeRecord[] = [
    {
      employeeId_date: 'LEP026_2026-07-26',
      employeeId: 'LEP026',
      date: '2026-07-26',
      dayOfWeek: 'CN',
      hours: 8.0,
      dayType: 'SUNDAY',
      verificationStatus: 'PENDING',
      month: 8,
      year: 2026
    }
  ];

  it('tự động đối soát và chuyển trạng thái MATCHED khi key LEP026 khớp ngày 26/07/2026 và đủ 8.0h', () => {
    const testRows: IExtractedFormRow[] = [
      {
        rowId: 'row_1',
        stt: 1,
        fullName: 'Nguyễn Bá Trình',
        employeeId: 'LEP026',
        department: 'WH',
        otDate: '2026-07-26',
        otDateRaw: '26/07/2026 CN',
        fromTime: '07:30',
        toTime: '16:00',
        otHours: 8.0,
        reason: 'Tăng ca Chủ nhật',
        confidence: 0.96
      }
    ];

    const result = reconcileRows(testRows, catalog, overtimesDb);
    expect(result).toHaveLength(1);
    expect(result[0].matchStatus).toBe('MATCHED');
    expect(result[0].dbHours).toBe(8.0);
    expect(result[0].details).toContain('Khớp');
  });

  it('tự động bóc tách LEP026 WH và chuẩn hóa ngày 26/07/2026 CN để đối soát MATCHED', () => {
    const testRows: IExtractedFormRow[] = [
      {
        rowId: 'row_2',
        stt: 1,
        fullName: '',
        employeeId: 'LEP026 WH',
        department: '',
        otDate: '',
        otDateRaw: '26/07/2026 CN',
        fromTime: '07:30',
        toTime: '16:00',
        otHours: 8.0,
        reason: '',
        confidence: 0.95
      }
    ];

    const result = reconcileRows(testRows, catalog, overtimesDb);
    expect(result).toHaveLength(1);
    expect(result[0].employeeId).toBe('LEP026');
    expect(result[0].otDate).toBe('2026-07-26');
    expect(result[0].fullName).toBe('Nguyễn Bá Trình');
    expect(result[0].department).toBe('WH');
    expect(result[0].matchStatus).toBe('MATCHED');
    expect(result[0].dbHours).toBe(8.0);
  });
});
