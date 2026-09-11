/**
 * OCR Table Engine - chuẩn hoá dữ liệu nhận dạng được từ pipeline ONNX thật
 *
 * Nguyên tắc: KHÔNG bịa giá trị mặc định. Nếu không parse được thì trả về
 * valid=false / hours=null và để người dùng sửa trên bảng preview.
 */
import { IEmployee } from '../types';
import type { OcrTableGrid } from '../types/ocr-worker-protocol';
import { extractCanonicalHRKey } from './hr-rag-postprocessor';

export interface IOCRBbox {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// 1. Chuẩn hoá mã nhân viên (LEP/LP, thiếu số 0, nhầm O với 0, hỗ trợ LEP000 và LEP000text)
// ---------------------------------------------------------------------------

export function normalizeEmployeeCode(rawText: string, catalog: IEmployee[] = []): {
  normalizedId: string;
  name: string;
  dept: string;
  matched: boolean;
} {
  if (!rawText) {
    return { normalizedId: '', name: '', dept: '', matched: false };
  }

  const tryCatalog = (candidate: string) =>
    catalog.find(e => e.employeeId.toUpperCase() === candidate.toUpperCase() || e.erpId?.toUpperCase() === candidate.toUpperCase());

  // 1. Trích xuất mã chuẩn nghiệp vụ (LEP000 hoặc LEP000A) - tách bỏ bộ phận dính kèm như WH, QC, KHO
  const canonical = extractCanonicalHRKey(rawText);
  if (canonical) {
    const foundCanonical = tryCatalog(canonical);
    if (foundCanonical) {
      return { normalizedId: foundCanonical.employeeId, name: foundCanonical.fullName, dept: foundCanonical.department, matched: true };
    }
    // Nếu có hậu tố chữ cái (ví dụ LEP170A), thử tìm mã gốc LEP170 trong danh mục
    if (/[A-Za-z]$/.test(canonical)) {
      const baseCode = canonical.slice(0, -1);
      const foundBase = tryCatalog(baseCode);
      if (foundBase) {
        return { normalizedId: foundBase.employeeId, name: foundBase.fullName, dept: foundBase.department, matched: true };
      }
    }
  }

  // 2. Đối chiếu trực tiếp
  const cleaned = rawText.toUpperCase().replace(/\s+/g, '');
  const direct = tryCatalog(cleaned);
  if (direct) {
    return { normalizedId: direct.employeeId, name: direct.fullName, dept: direct.department, matched: true };
  }

  // 3. Phương án phụ: chỉ có số (ví dụ user gõ "26" hoặc OCR chỉ đọc được "026") -> thử ghép LEP{num}
  if (/^\d{1,4}$/.test(cleaned)) {
    const num = parseInt(cleaned, 10);
    const candidate = `LEP${String(num).padStart(3, '0')}`;
    const found = tryCatalog(candidate);
    if (found) {
      return { normalizedId: found.employeeId, name: found.fullName, dept: found.department, matched: true };
    }
  }

  // 4. Trả về mã đã chuẩn hoá theo format LEP000/LEP000A (không dính chữ WH/KHO)
  return { normalizedId: canonical || cleaned || rawText.trim(), name: '', dept: '', matched: false };
}

// ---------------------------------------------------------------------------
// 2. Chuẩn hoá chuỗi ngày (26/07/2026, 26-07-2026, 2026-07-26 -> 2026-07-26)
// ---------------------------------------------------------------------------

export function normalizeDateString(rawDate: string): { normalizedDate: string; valid: boolean } {
  if (!rawDate) return { normalizedDate: '', valid: false };
  let input = String(rawDate).trim();
  if (!input) return { normalizedDate: '', valid: false };

  // 1. Sửa lỗi OCR số nhầm với chữ trong ngữ cảnh ngày tháng: O, o -> 0; l, I, i -> 1
  input = input
    .replace(/(?<=[/\-.\s]|^)[Oo](?=[0-9/\-.\s]|$)/g, '0')
    .replace(/(?<=[0-9/\-.\s]|^)[Oo](?=[/\-.\s]|$)/g, '0')
    .replace(/(?<=[/\-.\s]|^)[lIi](?=[0-9/\-.\s]|$)/g, '1')
    .replace(/(?<=[0-9/\-.\s]|^)[lIi](?=[/\-.\s]|$)/g, '1');

  // 2. ISO YYYY-MM-DD ưu tiên tránh nhầm với DD/MM/YYYY
  const iso = input.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) {
    return buildDate(iso[1], iso[2], iso[3]);
  }

  // 3. DD/MM/YYYY hoặc DD/MM/YY (cho phép có chữ khác đi kèm như CN, Chủ nhật, Ngày...)
  const matchFull = input.match(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})\b/);
  if (matchFull) {
    let year = matchFull[3];
    if (year.length === 2) year = `20${year}`;
    return buildDate(year, matchFull[2], matchFull[1]);
  }

  // 4. DD/MM (thiếu năm -> lấy năm 2026 mặc định cho kỳ chấm công hiện hành)
  const matchShort = input.match(/\b(\d{1,2})[/\-.](\d{1,2})\b/);
  if (matchShort) {
    return buildDate('2026', matchShort[2], matchShort[1]);
  }

  return { normalizedDate: '', valid: false };
}

function buildDate(y: string, m: string, d: string): { normalizedDate: string; valid: boolean } {
  const year = parseInt(y, 10);
  const month = parseInt(m, 10);
  const day = parseInt(d, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { normalizedDate: '', valid: false };
  // Kiểm tra ngày tồn tại thật trong tháng
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day > daysInMonth) return { normalizedDate: '', valid: false };
  return {
    normalizedDate: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
    valid: true
  };
}

// ---------------------------------------------------------------------------
// 3. Số giờ tăng ca: parse chuỗi HOẶC tính từ khung giờ - không bịa mặc định
// ---------------------------------------------------------------------------

export function parseOvertimeHours(
  rawHoursText: string,
  fromTime?: string,
  toTime?: string
): { hours: number | null; computedFromTime?: number } {
  let fTime = fromTime?.trim();
  let tTime = toTime?.trim();

  // Nếu rawHoursText chứa khung giờ dạng 07:30 - 16:00 thì ưu tiên tách fromTime/toTime
  const rangeMatch = rawHoursText?.match(/(\d{1,2}(?::\d{2}|h\d{0,2}))\s*[-–—~đếnto]+\s*(\d{1,2}(?::\d{2}|h\d{0,2}))/i);
  if (rangeMatch && (!fTime || !tTime)) {
    fTime ||= rangeMatch[1].replace('h', ':').padStart(5, '0');
    tTime ||= rangeMatch[2].replace('h', ':').padStart(5, '0');
  }

  // Chỉ parse số giờ nếu chuỗi KHÔNG phải là khung giờ dạng HH:MM - HH:MM
  let parsed: number | null = null;
  if (!/^\s*\d{1,2}:\d{2}\s*[-–—~đếnto]+\s*\d{1,2}:\d{2}\s*$/i.test(rawHoursText || '')) {
    const numMatch = rawHoursText?.match(/(\d+(?:[\.,]\d+)?)(?:\s*(?:h|giờ|tiếng))?/i);
    parsed = numMatch ? parseFloat(numMatch[1].replace(',', '.')) : null;
  }

  let computedHours: number | undefined;
  if (
    fTime && tTime &&
    /^\d{1,2}:\d{2}$/.test(fTime) &&
    /^\d{1,2}:\d{2}$/.test(tTime)
  ) {
    const [fh, fm] = fTime.split(':').map(Number);
    const [th, tm] = tTime.split(':').map(Number);
    let diffMins = (th * 60 + tm) - (fh * 60 + fm);
    let startMin = fh * 60 + fm;
    if (diffMins < 0) {
      diffMins += 24 * 60; // ca qua đêm (22:00 -> 06:00)
    }
    if (diffMins > 0) {
      // Quy ước biểu mẫu công ty: khung giờ >= 8 tiếng QUÉT QUA buổi trưa đã gồm 30 phút nghỉ trưa
      const endMin = startMin + diffMins;
      const overlapsNoonLunch = startMin < 13 * 60 && endMin > 12 * 60;
      const mins = diffMins >= 480 && overlapsNoonLunch ? diffMins - 30 : diffMins;
      computedHours = Math.round((mins / 60) * 100) / 100;
    }
  }

  const hours = parsed !== null && parsed > 0 ? parsed : (computedHours ?? null);
  return { hours, computedFromTime: computedHours };
}

// ---------------------------------------------------------------------------
// 4. Map lưới OCR (theo bố cục ảnh scan) -> các dòng bảng đã phân cột
// ---------------------------------------------------------------------------

type CanonicalField =
  | 'stt' | 'fullName' | 'employeeCode' | 'department'
  | 'date' | 'timeRange' | 'fromTime' | 'toTime'
  | 'hours' | 'reason' | 'unknown';

const COLUMN_PATTERNS: { field: CanonicalField; pattern: RegExp }[] = [
  { field: 'stt', pattern: /^(stt|số\s*tt|no\.?|seq)$/i },
  { field: 'employeeCode', pattern: /(mã\s*(?:số|nv|nhân viên|empl)|empl.*code|employee\s*code|^code|mã\s*nv)/i },
  { field: 'fullName', pattern: /(họ\s*(?:và|&)?\s*tên|họ|tên|full\s*name|^name)/i },
  { field: 'department', pattern: /(bộ\s*phận|đơn\s*vị|phòng|dept|department|bộ\s*phận\/phòng)/i },
  { field: 'date', pattern: /(ngày|date|ot\s*date)/i },
  { field: 'timeRange', pattern: /(thời\s*gian|giờ\s*làm|^time$|from\s*-\s*to|khung\s*giờ)/i },
  { field: 'fromTime', pattern: /(từ\s*(?:giờ)?|^from|bắt\s*đầu|giờ\s*vào|vào|start)/i },
  { field: 'toTime', pattern: /(đến\s*(?:giờ)?|^to$|kết\s*thúc|giờ\s*ra|ra|end)/i },
  { field: 'hours', pattern: /(số\s*giờ|ot\s*hours?|^hours?|giờ\s*(?:tăng\s*ca|tc)|tổng\s*(?:số\s*)?giờ|số\s*tiếng|ot\s*\(h\))/i },
  { field: 'reason', pattern: /(lý\s*do|reason|nội\s*dung|mục\s*đích)/i },
];

function classifyHeaderText(text: string): CanonicalField {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return 'unknown';
  for (const { field, pattern } of COLUMN_PATTERNS) {
    if (pattern.test(t)) return field;
  }
  return 'unknown';
}

/** Phân loại ô theo nội dung khi không tìm thấy dòng header */
function classifyByContent(text: string): CanonicalField {
  const t = text.trim();
  if (/^\d{1,2}$/.test(t)) return 'stt';
  if (/^(?:LEP|LP)\s*\d+[a-zA-Z]?/i.test(t)) return 'employeeCode';
  // Số giờ: 8, 8.0, 8,5, 8h, 8 giờ, 8 tiếng (ưu tiên trước date để tránh 8.0 bị nhầm là date)
  if (/^\d+(?:[\.,]\d+)?\s*(?:h|giờ|tiếng)?$/i.test(t)) return 'hours';
  // Chuỗi ngày tháng: DD/MM/YYYY, DD-MM-YYYY, DD/MM hoặc DD.MM.YYYY (có thể kèm thứ như 26/07/2026 CN)
  if (/(?:\b|\d{1,2})[/\-]\d{1,2}(?:[/\-]\d{2,4})?|\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/.test(t)) return 'date';
  // Khung giờ dạng 07:30 - 16:00 hoặc 7h30 - 16h
  if (/(\d{1,2}(?::\d{2}|h\d{0,2}))\s*[-–—~đếnto]+\s*(\d{1,2}(?::\d{2}|h\d{0,2}))/i.test(t)) return 'timeRange';
  if (/[\p{L}]/u.test(t) && t.length >= 3) return 'fullName';
  return 'unknown';
}

export interface IMappedTableRow {
  stt?: number;
  fullName?: string;
  employeeCode?: string;
  department?: string;
  /** Ngày thô trên phiếu, ví dụ 26/07/2026 */
  rawDate?: string;
  fromTime?: string;
  toTime?: string;
  hoursText?: string;
  reason?: string;
  confidence: number;
}

interface GridCellRef {
  text: string;
  confidence: number;
  x0: number;
  x1: number;
}

/**
 * Tái tạo cấu trúc bảng từ lưới OCR phản chiếu đúng bố cục ảnh scan:
 *  - Tìm dòng header bằng từ khoá (STT, Họ tên, Mã NV, Bộ phận, Ngày, Thời gian, Số giờ, Lý do)
 *  - Gán từng ô của các dòng sau vào cột theo khoảng x của header
 *  - Không có header thì phân loại theo nội dung từng ô (heuristic, người dùng kiểm tra lại)
 */
// Cache cho mapGridToTableRows để tránh tính lại khi grid trùng (tăng tốc, áp dụng cho toàn hệ thống chống lag)
const _gridCache = new Map<string, IMappedTableRow[]>();
const _gridCacheMax = 50;
function _gridKey(grid: OcrTableGrid): string {
  // Key nhẹ: số dòng + hash text ngắn (không dùng JSON.stringify toàn bộ để tránh nặng)
  let h = `${grid.rows.length}`;
  for (const r of grid.rows) {
    for (const c of r.cells) h += `|${c.text.slice(0,12)}:${Math.round(c.confidence*100)}`;
    if (h.length > 2000) break;
  }
  return h;
}

export function mapGridToTableRows(grid: OcrTableGrid): IMappedTableRow[] {
  if (grid.rows.length === 0) return [];
  const key = _gridKey(grid);
  const cached = _gridCache.get(key);
  if (cached) return cached;

  // 1. Tìm dòng header: hàng nhiều từ khoá cột nhất
  let headerIdx = -1;
  let headerScore = 0;
  let headerFields: CanonicalField[] = [];

  grid.rows.forEach((row, idx) => {
    const fields = row.cells.map(c => classifyHeaderText(c.text));
    const score = fields.filter(f => f !== 'unknown').length;
    if (score >= 2 && score > headerScore) {
      headerScore = score;
      headerIdx = idx;
      headerFields = fields;
    }
  });

  const dataRows = grid.rows
    .map((r, i) => ({ row: r, idx: i }))
    .filter(({ idx }) => idx !== headerIdx);

  // Bỏ các dòng trang trí/ký hiệu trống
  const meaningful = dataRows.filter(({ row }) => row.cells.some(c => c.text.trim().length > 0));

  const mapped: IMappedTableRow[] = [];

  if (headerIdx >= 0) {
    // Gán ô vào cột theo khoảng x của header
    const headerRow = grid.rows[headerIdx];
    const colRanges = headerRow.cells.map((c, i) => ({ x0: c.x0, x1: c.x1, field: headerFields[i] }));

    for (const { row } of meaningful) {
      const acc: Record<string, GridCellRef[]> = {};
      for (const cell of row.cells) {
        if (!cell.text.trim()) continue;
        const centerX = (cell.x0 + cell.x1) / 2;
        // Tìm cột header phủ tâm ô; không thấy thì chọn cột gần nhất có field rõ
        let best = colRanges.findIndex(cr => centerX >= cr.x0 - 20 && centerX <= cr.x1 + 20);
        if (best < 0) {
          let bestDist = Infinity;
          colRanges.forEach((cr, ci) => {
            const dist = Math.abs(centerX - (cr.x0 + cr.x1) / 2);
            if (dist < bestDist && cr.field !== 'unknown') { bestDist = dist; best = ci; }
          });
        }
        const field = best >= 0 ? colRanges[best].field : 'unknown';
        if (field === 'unknown') continue;
        (acc[field] ||= []).push(cell);
      }
      mapped.push(accumulateToRow(acc));
    }
    } else {
    // Không tìm thấy header: xếp hạng theo nội dung và toạ độ x
    for (const { row } of meaningful) {
      const acc: Record<string, GridCellRef[]> = {};
      const timeCells: GridCellRef[] = [];
      for (const cell of [...row.cells].sort((a, b) => a.x0 - b.x0)) {
        const trimmed = cell.text.trim();
        if (!trimmed) continue;
        // Ô giờ đơn dạng HH:MM (ví dụ 07:32, 16:07)
        if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
          timeCells.push(cell);
          continue;
        }
        const field = classifyByContent(cell.text);
        if (field === 'unknown') continue;
        (acc[field] ||= []).push(cell);
      }
      // Nếu có các ô giờ đơn (ví dụ cột Giờ vào và Giờ ra):
      if (timeCells.length >= 2) {
        (acc['fromTime'] ||= []).push(timeCells[0]);
        (acc['toTime'] ||= []).push(timeCells[1]);
      } else if (timeCells.length === 1) {
        (acc['fromTime'] ||= []).push(timeCells[0]);
      }
      const r = accumulateToRow(acc);
      if (Object.keys(r).length > 1) mapped.push(r);
    }
  }

  // Lưu cache vĩnh viễn cho grid đã tính (không áp dụng cho dữ liệu động liên tục như DB, chỉ cho OCR grid)
  if (_gridCache.size >= _gridCacheMax) {
    const firstKey = _gridCache.keys().next().value;
    if (firstKey) _gridCache.delete(firstKey);
  }
  _gridCache.set(key, mapped);
  return mapped;
}

function accumulateToRow(acc: Record<string, GridCellRef[]>): IMappedTableRow {
  const joinCells = (cells?: GridCellRef[]) => cells?.map(c => c.text.trim()).filter(Boolean).join(' ');
  const avgConf = (cells?: GridCellRef[]) =>
    cells && cells.length ? cells.reduce((s, c) => s + c.confidence, 0) / cells.length : 0;

  const sttRaw = joinCells(acc['stt']);
  const timeRange = joinCells(acc['timeRange']);
  let fromTime = joinCells(acc['fromTime']);
  let toTime = joinCells(acc['toTime']);
  if (timeRange && (!fromTime || !toTime)) {
    const parts = timeRange.match(/(\d{1,2}(?::\d{2}|h\d{0,2}))\s*[-–—~đếnto]+\s*(\d{1,2}(?::\d{2}|h\d{0,2}))/i);
    if (parts) {
      fromTime ||= parts[1].replace('h', ':').padStart(5, '0');
      toTime ||= parts[2].replace('h', ':').padStart(5, '0');
    }
  }

  const confidences = Object.values(acc).map(avgConf).filter(c => c > 0);

  return {
    stt: sttRaw ? parseInt(sttRaw, 10) || undefined : undefined,
    fullName: joinCells(acc['fullName']),
    employeeCode: joinCells(acc['employeeCode']),
    department: joinCells(acc['department']),
    rawDate: joinCells(acc['date']),
    fromTime,
    toTime,
    hoursText: joinCells(acc['hours']),
    reason: joinCells(acc['reason']),
    confidence: confidences.length ? confidences.reduce((s, c) => s + c, 0) / confidences.length : 0,
  };
}
