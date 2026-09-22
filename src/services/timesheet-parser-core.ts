import * as XLSX from 'xlsx';

export interface ParseProgressMessage {
  type: 'PROGRESS';
  progress: number; // 0..100
  message: string;
}

export interface ParseCompleteMessage {
  type: 'COMPLETE';
  rawLogsCount: number;
  timesheetCellsCount: number;
  overtimeRecordsCount: number;
  rawLogs: any[];
  timesheets: any[];
  overtimes: any[];
  /** Yêu cầu bù phép suy từ cột NGÀY NGHỈ PHÉP + PHÉP của file nguồn (để Header upsert, dedupe theo id) */
  leaves: any[];
  detectedPeriod?: {
    month: number;
    year: number;
    minDate: string;
    maxDate: string;
  };
}

export interface ParseErrorMessage {
  type: 'ERROR';
  error: string;
}

export type DateOrder = 'dmy' | 'mdy';

export function parseExcelDate(rawDate: any, order: DateOrder = 'dmy'): string {
  if (!rawDate) return '';
  // 1. Date object: Add 12h to absorb any historical timezone discrepancy (e.g. Asia/Ho_Chi_Minh 30s offset before 1975)
  if (rawDate instanceof Date) {
    const safeDate = new Date(rawDate.getTime() + 12 * 3600 * 1000);
    const y = safeDate.getUTCFullYear();
    const m = String(safeDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(safeDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // 2. Excel serial number (e.g. 46262 for 28/08/2026)
  if (typeof rawDate === 'number' && !isNaN(rawDate)) {
    if (rawDate > 1000) {
      try {
        const parsed = XLSX.SSF.parse_date_code(rawDate);
        if (parsed && parsed.y && parsed.m && parsed.d) {
          return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
        }
      } catch {}
    }
  }
  // 3. String (DD/MM/YYYY, MM/DD/YYYY hoặc YYYY-MM-DD)
  if (typeof rawDate === 'string' && rawDate.trim()) {
    const clean = rawDate.trim();
    const isoMatch = clean.match(/^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
    }
    const m = clean.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{4})/);
    if (m) {
      // order do detectDateOrder quyết định từ bằng chứng toàn file (VD máy chấm công xuất M/D/YYYY)
      const [a, b] = order === 'mdy' ? [m[2], m[1]] : [m[1], m[2]];
      const dd = a.padStart(2, '0');
      const mm = b.padStart(2, '0');
      if (parseInt(mm, 10) >= 1 && parseInt(mm, 10) <= 12 && parseInt(dd, 10) >= 1 && parseInt(dd, 10) <= 31) {
        return `${m[3]}-${mm}-${dd}`;
      }
    }
  }
  return '';
}

/**
 * Tự nhận diện thứ tự ngày của file: máy chấm công có thể xuất M/D/YYYY
 * (VD 8/21/2026) thay vì D/M/YYYY. Bằng chứng: số >12 chỉ nằm được ở vị trí ngày.
 */
export function detectDateOrder(rawValues: any[]): DateOrder {
  let dmyEvidence = 0;
  let mdyEvidence = 0;
  for (const v of rawValues) {
    if (typeof v !== 'string') continue;
    const m = v.trim().match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{4})/);
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a > 12 && b <= 12) dmyEvidence++;
    else if (b > 12 && a <= 12) mdyEvidence++;
  }
  // Mặc định Việt Nam D/M; chỉ chuyển M/D khi có bằng chứng và không bị phản bác
  if (mdyEvidence > 0 && dmyEvidence === 0) return 'mdy';
  return 'dmy';
}

export function parseExcelTime(val: any): string {
  if (!val && val !== 0) return '';
  if (typeof val === 'string') {
    const s = val.trim();
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (m) {
      return `${m[1].padStart(2, '0')}:${m[2]}`;
    }
    return '';
  }
  if (val instanceof Date) {
    const h = String(val.getHours()).padStart(2, '0');
    const min = String(val.getMinutes()).padStart(2, '0');
    return `${h}:${min}`;
  }
  if (typeof val === 'number' && !isNaN(val) && val >= 0 && val < 1) {
    const totalMinutes = Math.round(val * 24 * 60);
    const h = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0');
    const min = String(totalMinutes % 60).padStart(2, '0');
    return `${h}:${min}`;
  }
  return '';
}

/**
 * Dò tiêu đề theo TÊN CỘT (không phụ thuộc vị trí/số lượng/thứ tự cột).
 *
 * - Chuẩn hóa: bỏ dấu tiếng Việt, thường hóa, gọn khoảng trắng.
 * - Mỗi field có bộ alias cụm từ + token đơn; chấm điểm khớp:
 *   bằng nguyên văn = 100, khớp biên từ = 50, chứa chuỗi = 10-20.
 * - Giải quyết tranh chấp (VD "Tăng ca" vừa chứa token "ca" của Ca làm việc):
 *   greedy theo điểm cao nhất, mỗi cột chỉ gán 1 field.
 * - BẮT BUỘC có Mã NV + Ngày; thiếu thì caller ném lỗi nêu rõ tiêu đề tìm thấy
 *   (không fallback index cứng gây sai lệch âm thầm — KB-026).
 */

export type TimesheetFieldKey =
  | 'empId' | 'fullName' | 'departmentCode' | 'date' | 'dayOfWeek'
  | 'checkIn' | 'checkOut' | 'lateMins' | 'earlyMins'
  | 'workUnits' | 'totalHours' | 'otHours' | 'shift'
  | 'leaveDate' | 'leaveCode';

export type TimesheetColMap = Record<TimesheetFieldKey, number>;

export interface HeaderDetectResult {
  headerRowIndex: number;
  colMap: TimesheetColMap;
  /** Tiêu đề không gán được vào field nào (để thông báo, không lỗi) */
  unmapped: string[];
}

const FIELD_ALIASES: Record<TimesheetFieldKey, string[]> = {
  empId: ['ma nhan vien', 'ma nv', 'msnv', 'manv', 'employee id', 'employee', 'staff id', 'emp id', 'ma cham cong', 'erp id', 'erp', 'ma so nv', 'so the', 'enroll'],
  fullName: ['ho va ten', 'ten nhan vien', 'ten nv', 'ho ten', 'employee name', 'staff name', 'name', 'ten'],
  departmentCode: ['phong ban', 'bo phan', 'phong ban bo phan', 'department', 'dept', 'don vi', 'bophan'],
  date: ['ngay cham cong', 'work date', 'transaction date', 'ngay', 'date'],
  dayOfWeek: ['day of week', 'weekday', 'thu', 'day'],
  checkIn: ['gio vao', 'check in', 'checkin', 'time in', 'in time', 'vao ca', 'gio bat dau', 'bat dau', 'start time', 'vao', 'in'],
  checkOut: ['gio ra', 'check out', 'checkout', 'time out', 'out time', 'ra ca', 'gio ket thuc', 'ket thuc', 'end time', 'tan ca', 'ra', 'out'],
  lateMins: ['so phut tre', 'phut tre', 'di tre', 'late minutes', 'late', 'tre', 'muon'],
  earlyMins: ['so phut som', 'phut som', 've som', 'early minutes', 'early', 'som'],
  workUnits: ['ngay cong', 'so ngay cong', 'so cong', 'cong lam viec', 'cong chuan', 'work units', 'workunits', 'cong'],
  totalHours: ['tong so gio', 'tong gio lam viec', 'so gio lam', 'tong gio', 'total hours', 'hanh chinh', 'total'],
  otHours: ['so gio tang ca', 'gio tang ca', 'tang ca', 'overtime', 'gio tc', 'ot', 'tc'],
  shift: ['ca lam viec', 'ca lam', 'shift code', 'loai ca', 'shift', 'ca'],
  leaveDate: ['ngay nghi phep', 'ngay nghi', 'leave date', 'ngay phep'],
  leaveCode: ['loai phep', 'ma phep', 'leave type', 'leave code', 'phep'],
};

/** 'Mã NV.' → 'ma nv' | 'Giờ Vào' → 'gio vao' */
export function normalizeHeaderText(raw: any): string {
  return String(raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Điểm khớp của 1 alias với 1 ô tiêu đề đã chuẩn hóa. */
function aliasScore(norm: string, alias: string): number {
  if (!norm || !alias) return 0;
  if (norm === alias) return 100;
  if (alias.includes(' ')) {
    if (new RegExp(`(^| )${escapeRegExp(alias)}($| )`).test(norm)) return 50;
    if (norm.includes(alias)) return 20;
    return 0;
  }
  const tokens = norm.split(' ');
  if (tokens.includes(alias)) return 50;
  if (norm.includes(alias)) return 10;
  return 0;
}

const REQUIRED_FIELDS: TimesheetFieldKey[] = ['empId', 'date'];
const MIN_SCORE = 10;
const HEADER_SCAN_ROWS = 15;

function emptyColMap(): TimesheetColMap {
  return {
    empId: -1, fullName: -1, departmentCode: -1, date: -1, dayOfWeek: -1,
    checkIn: -1, checkOut: -1, lateMins: -1, earlyMins: -1,
    workUnits: -1, totalHours: -1, otHours: -1, shift: -1,
    leaveDate: -1, leaveCode: -1,
  };
}

export function detectHeaderRow(rows: any[][]): HeaderDetectResult | null {
  let best: HeaderDetectResult | null = null;
  let bestScore = -1;

  for (let r = 0; r < Math.min(HEADER_SCAN_ROWS, rows.length); r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;

    // Tiêu đề có thể chẻ 2 dòng (VD dòng trên "Mã" + dòng dưới "Nhân Viên",
    // "Điền" + "Giờ vào"): đánh giá cả dòng đơn lẫn dòng ghép với dòng trên.
    const variants: string[][] = [row.map(normalizeHeaderText)];
    if (r > 0 && Array.isArray(rows[r - 1])) {
      const prev = (rows[r - 1] as any[]).map(normalizeHeaderText);
      const width = Math.max(prev.length, variants[0].length);
      const merged: string[] = [];
      for (let i = 0; i < width; i++) {
        const a = prev[i] || '';
        const b = variants[0][i] || '';
        merged.push(a && b ? `${a} ${b}` : (a || b));
      }
      // Chỉ ghép khi dòng trên có chữ (tránh ghép dòng dữ liệu số)
      if (prev.some(n => n && /[a-z]/.test(n))) variants.push(merged);
    }

    for (const norms of variants) {
    if (norms.every(n => !n)) continue;

    // Mọi cặp (field, cột) kèm điểm, sắp giảm dần rồi gán greedy
    const cands: Array<{ field: TimesheetFieldKey; col: number; score: number }> = [];
    (Object.keys(FIELD_ALIASES) as TimesheetFieldKey[]).forEach((field) => {
      norms.forEach((norm, col) => {
        if (!norm) return;
        let s = 0;
        for (const alias of FIELD_ALIASES[field]) {
          s = Math.max(s, aliasScore(norm, alias));
        }
        if (s >= MIN_SCORE) cands.push({ field, col, score: s });
      });
    });
    cands.sort((a, b) => b.score - a.score);

    const colMap = emptyColMap();
    const usedCols = new Set<number>();
    let rowScore = 0;
    let matchedFields = 0;
    for (const c of cands) {
      if (colMap[c.field] !== -1 || usedCols.has(c.col)) continue;
      colMap[c.field] = c.col;
      usedCols.add(c.col);
      rowScore += c.score;
      matchedFields++;
    }

    const ok = REQUIRED_FIELDS.every(f => colMap[f] !== -1);
    if (!ok) continue;
    const total = rowScore + matchedFields;
    if (total > bestScore) {
      bestScore = total;
      const unmapped = norms.filter((n, idx) => n && !usedCols.has(idx));
      best = { headerRowIndex: r, colMap, unmapped: [...new Set(unmapped)] };
    }
    } // hết variants
  }
  return best;
}

/** Tóm tắt mapping để hiển thị tiến trình (VD "Mã NV→B, Ngày→E"). */
export function describeColMap(colMap: TimesheetColMap): string {
  const labels: Partial<Record<TimesheetFieldKey, string>> = {
    empId: 'Mã NV', fullName: 'Họ tên', date: 'Ngày', checkIn: 'Giờ vào', checkOut: 'Giờ ra',
  };
  const colLetter = (i: number) => {
    let n = i + 1, s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  return (Object.keys(labels) as TimesheetFieldKey[])
    .filter(f => colMap[f] >= 0)
    .map(f => `${labels[f]}→${colLetter(colMap[f])}`)
    .join(', ');
}
/**
 * Xử lý phân tích tệp Excel chấm công trực tiếp trong bộ nhớ (In-Memory Engine).
 * Hỗ trợ chia nhỏ chu kỳ (batch chunking) và nhả luồng UI để cập nhật thanh tiến trình mượt mà.
 */
export async function parseTimesheetInMemory(
  buffer: ArrayBuffer,
  month: number = 8,
  year: number = 2026,
  onProgress?: (progress: number, message: string) => void
): Promise<ParseCompleteMessage> {
  onProgress?.(5, 'Đang đọc tệp Excel chấm công...');
  await new Promise(r => setTimeout(r, 0));

  const byteLen = (buffer as any)?.byteLength ?? (buffer as any)?.length ?? 0;
  if (!buffer || byteLen === 0) {
    throw new Error('Tệp tải lên rỗng hoặc không có dữ liệu nhị phân.');
  }

  // Sử dụng Uint8Array và cellDates: false để tương thích tuyệt đối mọi trình duyệt
  const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer as ArrayBuffer);
  const workbook = XLSX.read(uint8, { type: 'array', cellDates: false });

  if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error('Tệp Excel không chứa bất kỳ trang tính (sheet) nào.');
  }

  // Check sheet name: ưu tiên sheet 'XuatLuoi', nếu không lấy sheet đầu tiên
  const sheetName = workbook.SheetNames.includes('XuatLuoi') ? 'XuatLuoi' : workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) {
    throw new Error(`Không tìm thấy dữ liệu trong trang tính "${sheetName}".`);
  }

  onProgress?.(20, `Đang phân tích cấu trúc sheet ${sheetName}...`);
  await new Promise(r => setTimeout(r, 0));

  // Convert sheet to json rows
  const rows: any[] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

  if (rows.length < 2) {
    throw new Error('Định dạng tệp Excel không hợp lệ hoặc dữ liệu quá ngắn.');
  }

  // Tự động nhận diện dòng tiêu đề theo TÊN CỘT (không phụ thuộc vị trí/số lượng/thứ tự).
  // Thiếu Mã NV hoặc Ngày → báo rõ tiêu đề tìm thấy thay vì đoán index cứng (KB-026).
  const detection = detectHeaderRow(rows as any[][]);
  if (!detection) {
    const preview = rows.slice(0, Math.min(5, rows.length))
      .map(r => `[${(Array.isArray(r) ? r : []).map(c => String(c ?? '').trim()).filter(Boolean).join(' | ')}]`)
      .join('\n');
    throw new Error(
      `Không nhận diện được cột "Mã NV" và "Ngày" trong ${HEADER_SCAN_ROWS} dòng đầu. ` +
      `File cần có cột mã nhân viên (VD: Mã NV / MSNV / Employee ID) và cột ngày (VD: Ngày / Date). ` +
      `Nội dung đầu file:\n${preview}`
    );
  }
  const { headerRowIndex, colMap, unmapped } = detection;

  // Nhận diện thứ tự ngày toàn file từ cột Ngày (máy có thể xuất M/D/YYYY)
  const dateOrder: DateOrder = detectDateOrder(
    rows.slice(headerRowIndex + 1, headerRowIndex + 201).map(r => (Array.isArray(r) && colMap.date >= 0 ? r[colMap.date] : ''))
  );

  const dataRows = rows.slice(headerRowIndex + 1);
  const totalRows = dataRows.length;

  onProgress?.(30, `Nhận diện cột: ${describeColMap(colMap)}. Tìm thấy ${totalRows.toLocaleString()} dòng quẹt thẻ. Đang chuẩn hóa dữ liệu...`);
  if (unmapped.length > 0) {
    onProgress?.(30, `Cột bỏ qua (không dùng): ${unmapped.slice(0, 6).join(', ')}${unmapped.length > 6 ? '...' : ''}`);
  }
  await new Promise(r => setTimeout(r, 0));

  const rawLogs: any[] = [];
  const timesheetMap = new Map<string, any>();
  const overtimeMap = new Map<string, any>();
  const leaves: any[] = [];
  let minDate = '';
  let maxDate = '';

  const chunkSize = 2000;
  for (let i = 0; i < totalRows; i++) {
    const row = dataRows[i];
    if (!row) continue;

    const empId = String(row[colMap.empId] || '').trim();
    if (!empId) continue; // Require Mã Nhân Viên

    // Parse date chuẩn xác không bị lệch múi giờ (thứ tự D/M hay M/D đã auto-detect)
    const dateStr = parseExcelDate(row[colMap.date], dateOrder);
    if (!dateStr) continue;

    if (!minDate || dateStr < minDate) minDate = dateStr;
    if (!maxDate || dateStr > maxDate) maxDate = dateStr;

    const checkIn = parseExcelTime(row[colMap.checkIn]);
    const checkOut = parseExcelTime(row[colMap.checkOut]);
    const lateMins = parseFloat(String(row[colMap.lateMins] || '0').replace(',', '.')) || 0;
    const earlyMins = parseFloat(String(row[colMap.earlyMins] || '0').replace(',', '.')) || 0;
    const workUnits = parseFloat(String(row[colMap.workUnits] || '0').replace(',', '.')) || 0;
    const totalHours = parseFloat(String(row[colMap.totalHours] || '0').replace(',', '.')) || 0;
    const otHours = parseFloat(String(row[colMap.otHours] || '0').replace(',', '.')) || 0;
    const dayOfWeek = String(row[colMap.dayOfWeek] || '').trim();
    const shift = String(row[colMap.shift] || '').trim();

    // Cột phép riêng của file nguồn (NGÀY NGHỈ PHÉP + PHÉP: AL/PH/...).
    // Có quẹt thẻ thì hiện diện thắng (bỏ qua cột phép); không quẹt + có mã phép
    // thì chốt mã phép vào ô công và sinh yêu cầu chờ duyệt (quota-safe, Header dedupe theo id).
    const KNOWN_LEAVE_CODES = ['AL', 'UL', 'SL', 'PL', 'PH', 'BT', 'ML', 'WO'];
    const QUOTA_LEAVE = ['AL', 'UL', 'SL', 'PL'];
    const leaveCodeRaw = colMap.leaveCode >= 0 ? String(row[colMap.leaveCode] || '').trim().toUpperCase() : '';
    const leaveDateStr = colMap.leaveDate >= 0 ? parseExcelDate(row[colMap.leaveDate], dateOrder) : '';
    let sourceLeave: { code: string; targetDate: string } | null = null;
    if (!checkIn && !checkOut && leaveCodeRaw) {
      const code = KNOWN_LEAVE_CODES.includes(leaveCodeRaw) ? leaveCodeRaw : 'Off';
      const targetDate = leaveDateStr || dateStr;
      sourceLeave = { code, targetDate };
      if (!minDate || targetDate < minDate) minDate = targetDate;
      if (!maxDate || targetDate > maxDate) maxDate = targetDate;
    }

    const logItem = {
      employeeId: empId,
      fullName: String(row[colMap.fullName] || '').trim(),
      departmentCode: String(row[colMap.departmentCode] || '').trim(),
      date: dateStr,
      dayOfWeek,
      checkIn,
      checkOut,
      lateMinutes: lateMins,
      earlyMinutes: earlyMins,
      workUnits,
      totalHours,
      overtimeHours: otHours,
      shiftName: shift
    };
    rawLogs.push(logItem);

    // Determine timesheet status - cập nhật hỗ trợ LA/ED/MCO/MCI chuẩn theo yêu cầu
    let statusCode = '';
    const dowNorm = dayOfWeek.toLowerCase();
    const isSunday = dayOfWeek === 'CN' || dowNorm.includes('sun') || dowNorm.includes('chu nhat') || dowNorm.includes('chủ nhật');

    if (sourceLeave) {
      // Ngày phép theo file nguồn: chốt mã phép, chờ duyệt trong menu bù phép (quota-safe)
      statusCode = sourceLeave.code;
    } else if (!checkIn && !checkOut) {
      if (!isSunday) {
        // Ngày thường không quẹt thẻ -> OFF, chuyển sang danh sách chờ bù phép
        statusCode = 'OFF';
      } else {
        statusCode = ''; // CN nghỉ tuần
      }
    } else if (!checkIn && checkOut) {
      // Có giờ ra nhưng không có giờ vào -> MCO
      statusCode = 'MCO';
    } else if (checkIn && !checkOut) {
      // Có giờ vào nhưng không có giờ ra -> MCI
      statusCode = 'MCI';
    } else {
      // Cả vào và ra đều có: kiểm tra ca đêm / ca 2 trước
      const isNightOrShift2 = shift.includes('2') || shift.includes('N') || shift.toLowerCase().includes('đêm') || (checkIn >= '14:00' && checkIn < '18:00');
      // Ngưỡng mới: >= 60p -> OFF (chờ bù phép); từ 2p đến <60p trễ -> LA; từ 2p đến <60p sớm -> ED
      if (lateMins >= 60 || earlyMins >= 60) {
        statusCode = 'OFF';
      } else if (lateMins >= 2) {
        statusCode = 'LA';
      } else if (earlyMins >= 2) {
        statusCode = 'ED';
      } else {
        statusCode = isNightOrShift2 ? 'N' : 'W'; // Vào đúng giờ, ra đúng giờ (ca 2 là N, ca khác là W)
      }
    }

    // Ghi chú chi tiết theo mã
    let violationNote: string | undefined;
    if (sourceLeave) {
      violationNote = sourceLeave.code === 'Off'
        ? `Mã phép lạ "${leaveCodeRaw}" theo bảng nguồn — ghi nhận chờ bù phép`
        : `Theo bảng nguồn: nghỉ ${sourceLeave.code} ngày ${sourceLeave.targetDate} (chờ duyệt)`;
    } else if (statusCode === 'MCO') violationNote = `Chỉ có giờ ra, không có giờ vào (quẹt ra: ${checkOut})`;
    else if (statusCode === 'MCI') violationNote = `Chỉ có giờ vào, không có giờ ra (quẹt vào: ${checkIn})`;
    else if (statusCode === 'OFF' && (lateMins >= 60 || earlyMins >= 60)) {
      const missed = Math.min(8, Math.max(1, Math.round((lateMins + earlyMins) / 60)));
      violationNote = lateMins >= 60
        ? `Đi trễ ${lateMins} phút (≥ 60p) - vắng ${missed}h (chờ bù phép)`
        : `Về sớm ${earlyMins} phút (≥ 60p) - vắng ${missed}h (chờ bù phép)`;
    }
    else if (statusCode === 'LA') violationNote = `Đi trễ ${lateMins} phút (LA) - vào lúc ${checkIn}`;
    else if (statusCode === 'ED') violationNote = `Về sớm ${earlyMins} phút (ED) - ra lúc ${checkOut}`;
    else if (lateMins > 0) violationNote = `Đi trễ ${lateMins} phút`;
    else if (earlyMins > 0) violationNote = `Về sớm ${earlyMins} phút`;

    const isViolation = statusCode === 'LA' || statusCode === 'ED' || statusCode === 'MCO' || statusCode === 'MCI' || statusCode === 'OFF' || statusCode === 'Off';

    // Ô công chốt theo ngày phép nguồn nếu có (NGÀY NGHỈ PHÉP có thể khác cột Ngày)
    const cellDate = sourceLeave ? sourceLeave.targetDate : dateStr;
    const key = `${empId}_${cellDate}`;
    timesheetMap.set(key, {
      employeeId_date: key,
      employeeId: empId,
      date: cellDate,
      dayIndex: parseInt(cellDate.split('-')[2], 10),
      statusCode,
      checkIn,
      checkOut,
      lateMinutes: lateMins,
      earlyMinutes: earlyMins,
      isViolation,
      isViolationFlag: isViolation ? 1 : 0,
      violationNote,
      calculatedOvertime: otHours,
      // Cờ nội bộ (prefix _ → tables.ts strip khi upsert): ô phép từ file nguồn,
      // Header giữ nguyên mã phép, không tính lại thành OFF (KB-027)
      _sourceLeave: sourceLeave ? leaveCodeRaw : undefined,
      month,
      year
    });

    // Sinh yêu cầu chờ duyệt cho phép tính quota (AL/UL/SL/PL); PH/BT/ML là sự thật đã chốt, không quota
    if (sourceLeave && QUOTA_LEAVE.includes(sourceLeave.code)) {
      leaves.push({
        id: `LEAVE_${empId}_${sourceLeave.targetDate}`,
        employeeId: empId,
        fullName: String(row[colMap.fullName] || '').trim(),
        department: String(row[colMap.departmentCode] || '').trim(),
        date: sourceLeave.targetDate,
        leaveType: sourceLeave.code,
        durationDays: 1,
        missedHours: 8,
        workedHours: 0,
        status: 'PENDING',
        reason: `Theo bảng nguồn (${leaveCodeRaw}${leaveDateStr && leaveDateStr !== dateStr ? ` ngày ${leaveDateStr}` : ''})`,
      });
    }

    // Calculate Overtime
    if (otHours > 0 || (isSunday && totalHours > 0)) {
      const finalOT = otHours > 0 ? otHours : totalHours;
      overtimeMap.set(key, {
        employeeId_date: key,
        employeeId: empId,
        date: dateStr,
        dayOfWeek,
        hours: finalOT,
        dayType: isSunday ? 'SUNDAY' : 'WEEKDAY',
        verificationStatus: 'PENDING',
        month,
        year
      });
    }

    // Cập nhật tiến trình tuần tự và nhường luồng event-loop cho UI
    if (i % chunkSize === 0 || i === totalRows - 1) {
      const pct = Math.round(30 + (i / totalRows) * 65);
      onProgress?.(pct, `Đã xử lý ${i.toLocaleString()} / ${totalRows.toLocaleString()} dòng...`);
      await new Promise(r => setTimeout(r, 0));
    }
  }

  let detectedPeriod: { month: number; year: number; minDate: string; maxDate: string } | undefined = undefined;
  if (maxDate) {
    const parts = maxDate.split('-');
    const dYear = parseInt(parts[0], 10);
    const dMonth = parseInt(parts[1], 10);
    detectedPeriod = {
      month: dMonth,
      year: dYear,
      minDate,
      maxDate
    };
  }

  return {
    type: 'COMPLETE',
    rawLogsCount: rawLogs.length,
    timesheetCellsCount: timesheetMap.size,
    overtimeRecordsCount: overtimeMap.size,
    rawLogs,
    timesheets: Array.from(timesheetMap.values()),
    overtimes: Array.from(overtimeMap.values()),
    leaves,
    detectedPeriod
  };
}
