import * as XLSX from 'xlsx';
import type { IEmployee } from '../types';
import { normalizeHeaderText } from './timesheet-parser-core';
import { parseExcelDate } from './timesheet-parser-core';

/**
 * employee-excel — nhập nhanh nhân viên từ Excel (menu Danh sách nhân viên).
 * - `downloadEmployeeTemplate()`: tải file mẫu đủ trường như modal Thêm NV mới.
 * - `parseEmployeeExcel()`: đọc + validate → { employees, errors }.
 * - Mã NV trùng → gọi bulkUpsert phía caller (cập nhật đè, user đã chốt).
 */

export interface EmployeeParseError {
  row: number; // dòng Excel (1-based, tính cả header)
  employeeId: string;
  message: string;
}

export interface EmployeeParseResult {
  employees: IEmployee[];
  errors: EmployeeParseError[];
}

export interface ProductionLineRef {
  id: string;
  name: string;
}

/** Thứ tự cột mẫu (21 cột, khớp modal Thêm NV mới) */
export const EMPLOYEE_TEMPLATE_HEADERS = [
  'Mã NV *',
  'Mã ERP',
  'Họ và tên *',
  'Phòng ban',
  'Chức vụ',
  'Ngày vào làm (DD/MM/YYYY)',
  'Loại hợp đồng (Chính thức/Thời vụ)',
  'Nhóm ca (T2-T6/T2-T7/Ca 1/Ca 2)',
  'Trạng thái (Đang làm việc/Đã nghỉ việc/Thai sản)',
  'Line sản xuất (tên Line)',
  'Nhóm năng suất (1/2)',
  'Loại HĐ (1 tháng/2 tháng/1 năm/3 năm/Vĩnh viễn)',
  'Ngày bắt đầu HĐ (DD/MM/YYYY)',
  'Ngày kết thúc HĐ (DD/MM/YYYY)',
  'Thử việc (tháng: 1/2)',
  'Kết thúc thử việc (DD/MM/YYYY)',
  'Trợ cấp PCCC (VNĐ)',
  'Tiền độc hại (VNĐ)',
  'Tiền chuyên cần (VNĐ)',
  'Thưởng năng suất (VNĐ)',
  'Phép năm ban đầu (ngày)',
];

const GUIDE_ROWS: string[][] = [
  ['Cột', 'Giá trị hợp lệ', 'Mặc định khi bỏ trống'],
  ['Mã NV', 'Bắt buộc, duy nhất (VD: LEP010). Trùng mã → cập nhật đè.', '—'],
  ['Họ và tên', 'Bắt buộc', '—'],
  ['Phòng ban', 'Tên tự do (VD: Production, WH, QC, EHS, Finance)', 'Production'],
  ['Chức vụ', 'Tên tự do (VD: Operator)', 'Operator'],
  ['Ngày vào làm', 'DD/MM/YYYY hoặc YYYY-MM-DD', 'Hôm nay'],
  ['Loại hợp đồng', 'Chính thức | Thời vụ (hoặc OFFICIAL | SEASONAL)', 'Chính thức'],
  ['Nhóm ca', 'T2-T6 | T2-T7 | Ca 1 | Ca 2 (hoặc OFFICE_M_F | OFFICE_M_S | SHIFT_1 | SHIFT_2)', 'T2-T7'],
  ['Trạng thái', 'Đang làm việc | Đã nghỉ việc | Thai sản (hoặc ACTIVE | RESIGNED | MATERNITY)', 'Đang làm việc'],
  ['Line sản xuất', 'Tên Line đúng như menu Tỷ lệ NS & CL (bỏ trống = không thuộc Line)', '—'],
  ['Nhóm năng suất', '1 | 2 (bỏ trống = không phân nhóm)', '—'],
  ['Loại HĐ', '1 tháng | 2 tháng | 1 năm | 3 năm | Vĩnh viễn', '—'],
  ['Thử việc (tháng)', '1 | 2 (bỏ trống = không thử việc)', '—'],
  ['PCCC / Độc hại / Chuyên cần / Thưởng NS', 'Số VNĐ', '0 / 0 / 500000 / 0'],
  ['Phép năm ban đầu', 'Số ngày', '12'],
];

export async function downloadEmployeeTemplate(): Promise<void> {
  const ws = XLSX.utils.aoa_to_sheet([EMPLOYEE_TEMPLATE_HEADERS]);
  ws['!cols'] = EMPLOYEE_TEMPLATE_HEADERS.map(() => ({ wch: 24 }));
  const guide = XLSX.utils.aoa_to_sheet(GUIDE_ROWS);
  guide['!cols'] = [{ wch: 26 }, { wch: 52 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'NhanVien');
  XLSX.utils.book_append_sheet(wb, guide, 'HuongDan');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Mau_Them_Nhan_Vien.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- Mapping giá trị tiếng Việt → mã hệ thống ---

function mapContractType(v: string): 'OFFICIAL' | 'SEASONAL' | null {
  const n = normalizeHeaderText(v);
  if (!n) return null;
  if (['official', 'chinh thuc', 'chinhthuc', 'ct'].includes(n)) return 'OFFICIAL';
  if (['seasonal', 'thoi vu', 'thoivu', 'tv'].includes(n)) return 'SEASONAL';
  return null;
}

function mapShiftClass(v: string): IEmployee['shiftClassId'] | null {
  const n = normalizeHeaderText(v);
  if (!n) return null;
  if (['office m f', 't2 t6', 't2t6', 'hc t2 t6', 'hanh chinh t2 t6'].includes(n)) return 'OFFICE_M_F';
  if (['office m s', 't2 t7', 't2t7', 'hc t2 t7', 'hanh chinh t2 t7', 'hanh chinh'].includes(n)) return 'OFFICE_M_S';
  if (['shift 1', 'ca 1', 'ca1'].includes(n)) return 'SHIFT_1';
  if (['shift 2', 'ca 2', 'ca2'].includes(n)) return 'SHIFT_2';
  return null;
}

function mapStatus(v: string): IEmployee['status'] | null {
  const n = normalizeHeaderText(v);
  if (!n) return null;
  if (['active', 'dang lam viec', 'dang lam', 'lam viec'].includes(n)) return 'ACTIVE';
  if (['resigned', 'da nghi viec', 'nghi viec', 'da nghi'].includes(n)) return 'RESIGNED';
  if (['maternity', 'thai san', 'nghi thai san'].includes(n)) return 'MATERNITY';
  return null;
}

function mapContractTerm(v: string): IEmployee['contractTerm'] | null {
  const n = normalizeHeaderText(v);
  if (!n) return null;
  if (['1 month', '1 thang', 'hd 1 thang', '1m'].includes(n)) return '1_MONTH';
  if (['2 months', '2 thang', 'hd 2 thang', '2m'].includes(n)) return '2_MONTHS';
  if (['1 year', '1 nam', 'hd 1 nam', '1y'].includes(n)) return '1_YEAR';
  if ( ['3 years', '3 nam', 'hd 3 nam', '3y'].includes(n)) return '3_YEARS';
  if (['permanent', 'vinh vien', 'khong thoi han', 'dai han'].includes(n)) return 'PERMANENT';
  return null;
}

function parseNum(v: any): number {
  if (v === '' || v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  // VN: dot = nghìn, comma = thập phân; EN ngược lại → đoán theo vị trí cuối
  let s = String(v).trim().replace(/\s/g, '').replace(/[^\d.,\-]/g, '');
  if (!s || s === '-' || s === '.' || s === ',') return NaN;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    s = /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (hasDot) {
    while (/\.\d{3}$/.test(s)) s = s.replace(/\.(\d{3})$/, '$1');
  }
  const n = parseFloat(s);
  return isNaN(n) ? NaN : n;
}

/** YYYY-MM-DD (parseExcelDate) → DD/MM/YYYY (quy ước trường ngày nhân sự) */
function toDisplayDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

function todayDisplay(): string {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// Chỉ số cột theo header đã chuẩn hóa (chịu đảo cột, alias cơ bản)
const COL_ALIASES: Array<{ key: string; aliases: string[] }> = [
  { key: 'employeeId', aliases: ['ma nv', 'manv', 'msnv', 'employee id'] },
  { key: 'erpId', aliases: ['ma erp', 'erp', 'erp id', 'ma cham cong'] },
  { key: 'fullName', aliases: ['ho va ten', 'ho ten', 'ten', 'ten nhan vien'] },
  { key: 'department', aliases: ['phong ban', 'bo phan', 'department'] },
  { key: 'position', aliases: ['chuc vu', 'position', 'vi tri'] },
  { key: 'startDate', aliases: ['ngay vao lam', 'ngay vao', 'ngay bat dau', 'start date'] },
  { key: 'contractType', aliases: ['loai hop dong', 'hop dong', 'contract type'] },
  { key: 'shiftClassId', aliases: ['nhom ca', 'ca lam viec', 'shift'] },
  { key: 'status', aliases: ['trang thai', 'status'] },
  { key: 'productionLine', aliases: ['line san xuat', 'line', 'chuyen'] },
  { key: 'productivityGroup', aliases: ['nhom nang suat', 'nhom ns'] },
  { key: 'contractTerm', aliases: ['loai hd', 'thoi han hop dong'] },
  { key: 'contractStartDate', aliases: ['ngay bat dau hd', 'bd hd'] },
  { key: 'contractEndDate', aliases: ['ngay ket thuc hd', 'kt hd'] },
  { key: 'probationMonths', aliases: ['thu viec thang', 'thu viec', 'probation'] },
  { key: 'probationEndDate', aliases: ['ket thuc thu viec', 'kt thu viec'] },
  { key: 'pccc', aliases: ['tro cap pccc', 'pccc'] },
  { key: 'hazardous', aliases: ['tien doc hai', 'doc hai'] },
  { key: 'diligence', aliases: ['tien chuyen can', 'chuyen can'] },
  { key: 'prodBonus', aliases: ['thuong nang suat', 'thuong ns'] },
  { key: 'leaveQuota', aliases: ['phep nam ban dau', 'phep nam', 'han muc phep'] },
];

function detectEmpColumns(headerRow: any[]): Record<string, number> {
  const norms = headerRow.map(normalizeHeaderText);
  const map: Record<string, number> = {};
  COL_ALIASES.forEach(({ key, aliases }) => {
    for (let i = 0; i < norms.length; i++) {
      const n = norms[i];
      if (!n || map[key] !== undefined) continue;
      if (aliases.some(a => n === a || n.startsWith(a + ' ') || n.startsWith(a + ' ('))) {
        map[key] = i;
        break;
      }
    }
  });
  return map;
}

export function parseEmployeeExcel(
  buffer: ArrayBuffer,
  lines: ProductionLineRef[] = []
): EmployeeParseResult {
  const wb = XLSX.read(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer as ArrayBuffer), { type: 'array', cellDates: false });
  if (!wb.SheetNames.length) throw new Error('File Excel không có sheet nào.');
  const ws = wb.Sheets[wb.SheetNames.includes('NhanVien') ? 'NhanVien' : wb.SheetNames[0]];
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (rows.length < 2) throw new Error('File mẫu chưa có dòng dữ liệu nào (cần ít nhất header + 1 dòng).');

  const col = detectEmpColumns(rows[0]);
  if (col.employeeId === undefined || col.fullName === undefined) {
    throw new Error('Không nhận diện được cột "Mã NV" và "Họ và tên". Hãy tải file mẫu mới nhất từ nút "Tải mẫu Excel".');
  }

  const lineByName = new Map(lines.map(l => [normalizeHeaderText(l.name), l.id]));
  const lineById = new Set(lines.map(l => l.id));
  const cell = (r: any[], k: string): string => {
    const idx = col[k];
    if (idx === undefined) return '';
    return String(r[idx] ?? '').trim();
  };

  const employees: IEmployee[] = [];
  const errors: EmployeeParseError[] = [];
  const seenInFile = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r) || r.every(c => String(c ?? '').trim() === '')) continue;
    const excelRow = i + 1;
    const employeeId = cell(r, 'employeeId');
    const fullName = cell(r, 'fullName');
    const fail = (message: string) => errors.push({ row: excelRow, employeeId, message });

    if (!employeeId) { fail('Thiếu Mã NV (bắt buộc).'); continue; }
    if (!fullName) { fail('Thiếu Họ và tên (bắt buộc).'); continue; }
    const idKey = employeeId.toUpperCase();
    if (seenInFile.has(idKey)) { fail(`Mã NV "${employeeId}" trùng lặp trong file (chỉ giữ dòng đầu).`); continue; }
    seenInFile.add(idKey);

    const contractTypeRaw = cell(r, 'contractType');
    const contractType = contractTypeRaw ? mapContractType(contractTypeRaw) : 'OFFICIAL';
    if (contractTypeRaw && !contractType) { fail(`Loại hợp đồng "${contractTypeRaw}" không hợp lệ (Chính thức/Thời vụ).`); continue; }

    const shiftRaw = cell(r, 'shiftClassId');
    const shiftClassId = shiftRaw ? mapShiftClass(shiftRaw) : 'OFFICE_M_S';
    if (shiftRaw && !shiftClassId) { fail(`Nhóm ca "${shiftRaw}" không hợp lệ (T2-T6/T2-T7/Ca 1/Ca 2).`); continue; }

    const statusRaw = cell(r, 'status');
    const status = statusRaw ? mapStatus(statusRaw) : 'ACTIVE';
    if (statusRaw && !status) { fail(`Trạng thái "${statusRaw}" không hợp lệ.`); continue; }

    const termRaw = cell(r, 'contractTerm');
    const contractTerm = termRaw ? mapContractTerm(termRaw) : undefined;
    if (termRaw && !contractTerm) { fail(`Loại HĐ "${termRaw}" không hợp lệ (1 tháng/2 tháng/1 năm/3 năm/Vĩnh viễn).`); continue; }

    const probRaw = cell(r, 'probationMonths');
    let probationMonths: 1 | 2 | undefined;
    if (probRaw) {
      const p = parseInt(probRaw, 10);
      if (p !== 1 && p !== 2) { fail(`Thử việc "${probRaw}" phải là 1 hoặc 2 (tháng).`); continue; }
      probationMonths = p as 1 | 2;
    }

    const grpRaw = cell(r, 'productivityGroup');
    let productivityGroup: 1 | 2 | undefined;
    if (grpRaw) {
      const g = parseInt(grpRaw, 10);
      if (g !== 1 && g !== 2) { fail(`Nhóm năng suất "${grpRaw}" phải là 1 hoặc 2.`); continue; }
      productivityGroup = g as 1 | 2;
    }

    const dateOf = (k: string, label: string): string | null => {
      const raw = cell(r, k);
      if (!raw) return '';
      const iso = parseExcelDate((r[col[k]] as any), 'dmy');
      if (!iso) { fail(`${label} "${raw}" không phải ngày hợp lệ (DD/MM/YYYY).`); return null; }
      return toDisplayDate(iso);
    };
    const startDate = dateOf('startDate', 'Ngày vào làm') ?? todayDisplay();
    if (startDate === null) continue;
    const contractStartDate = dateOf('contractStartDate', 'Ngày bắt đầu HĐ');
    if (contractStartDate === null) continue;
    const contractEndDate = dateOf('contractEndDate', 'Ngày kết thúc HĐ');
    if (contractEndDate === null) continue;
    const probationEndDate = dateOf('probationEndDate', 'Kết thúc thử việc');
    if (probationEndDate === null) continue;

    const numOf = (k: string, label: string, def: number): number | null => {
      const raw = cell(r, k);
      if (!raw) return def;
      const n = parseNum(raw);
      if (isNaN(n)) { fail(`${label} "${raw}" không phải số.`); return null; }
      return n;
    };
    const pccc = numOf('pccc', 'Trợ cấp PCCC', 0);
    const hazardous = numOf('hazardous', 'Tiền độc hại', 0);
    const diligence = numOf('diligence', 'Tiền chuyên cần', 500000);
    const prodBonus = numOf('prodBonus', 'Thưởng năng suất', 0);
    const leaveQuota = numOf('leaveQuota', 'Phép năm ban đầu', 12);
    if ([pccc, hazardous, diligence, prodBonus, leaveQuota].some(v => v === null)) continue;

    const lineRaw = cell(r, 'productionLine');
    let productionLine: string | undefined;
    if (lineRaw) {
      if (lineById.has(lineRaw)) productionLine = lineRaw;
      else {
        const resolved = lineByName.get(normalizeHeaderText(lineRaw));
        if (!resolved) { fail(`Line "${lineRaw}" không khớp danh mục (xem menu Tỷ lệ NS & CL).`); continue; }
        productionLine = resolved;
      }
    }

    employees.push({
      employeeId,
      erpId: cell(r, 'erpId') || '',
      fullName,
      department: cell(r, 'department') || 'Production',
      position: cell(r, 'position') || 'Operator',
      startDate: startDate || todayDisplay(),
      contractType: contractType!,
      shiftClassId: shiftClassId!,
      customAllowances: {
        pcccAllowance: pccc!,
        hazardousAllowance: hazardous!,
        diligenceBonus: diligence!,
        productivityBonus: prodBonus!,
        tradeUnionFee: -40000,
        otherFees: 0,
        extraBonus: 0,
      },
      annualLeaveBalance: {
        initialQuota: leaveQuota!,
        usedDays: 0,
        remainingDays: Math.max(0, leaveQuota!),
      },
      status: status!,
      ...(contractTerm ? { contractTerm } : {}),
      ...(contractStartDate ? { contractStartDate } : {}),
      ...(contractEndDate ? { contractEndDate } : {}),
      ...(probationMonths ? { probationMonths } : {}),
      ...(probationEndDate ? { probationEndDate } : {}),
      ...(productionLine ? { productionLine } : {}),
      ...(productivityGroup ? { productivityGroup } : {}),
    });
  }

  return { employees, errors };
}
