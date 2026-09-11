/**
 * HR RAG Post-Processor - Tinh chỉnh kết quả OCR cho ngữ cảnh HR tiếng Việt
 * 
 * Chạy 100% trên browser, KHÔNG cần Python.
 * Áp dụng sau khi ONNX OCR trả về raw text để:
 * 1. Sửa lỗi nhận dạng đặc thù HR (LEPOOO → LEP000, O → 0, l → 1)
 * 2. Chuẩn hóa format ngày tháng (dd/mm/yyyy), giờ (HH:MM)
 * 3. Nhận diện và gắn nhãn field types (employeeId, date, time, shift, status)
 * 4. Post-process tiếng Việt có dấu bị mất/nhầm
 */

// ---------------------------------------------------------------------------
// HR RAG Context - Từ điển ngữ cảnh chấm công HR
// ---------------------------------------------------------------------------

export const HR_RAG_CONTEXT = {
  // Patterns regex để classify field — chuẩn nghiệp vụ: LEP000 hoặc LEP000A (ví dụ LEP170, LEP170A)
  patterns: {
    employeeId: /^LEP\d{3}[A-Za-z]?$/i,
    internalId: /^\d{7}$/,
    date: /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/,
    time: /^\d{1,2}:\d{2}$/,
    shift: /^(HC1|HC2|N1|N2|V|T[1-3])$/,
    status: /^(W|AL|SL|UL|N|CL|P|K|X|0)$/,
    overtimeHours: /^\d+(\.\d+)?$/,
    dayOfWeek: /^(Hai|Ba|Tư|Năm|Sáu|Bảy|CN|T2|T3|T4|T5|T6|T7)$/,
  },

  // Auto-corrections cho lỗi OCR thường gặp trong bảng chấm công
  corrections: {
    // Mã nhân viên
    'LEPOOO': 'LEP000', 'LEPOO1': 'LEP001', 'LEPOO4': 'LEP004',
    'LEPOO5': 'LEP005', 'LEPOO7': 'LEP007', 'LEPOO9': 'LEP009',
    'LEPO1O': 'LEP010', 'LEPO11': 'LEP011', 'LEPO14': 'LEP014',
    'LEPO18': 'LEP018', 'LEPO22': 'LEP022', 'LEPO23': 'LEP023',
    'LEPO26': 'LEP026', 'LEPO27': 'LEP027', 'LEPO28': 'LEP028',
    'LEPO29': 'LEP029', 'LEPO31': 'LEP031', 'LEPO36': 'LEP036',
    'LEPO4O': 'LEP040',
    
    // Ca làm việc
    'HCl': 'HC1', 'HCi': 'HC1', 'HC2': 'HC2',
    'V ': 'V', ' V': 'V',
    
    // Trạng thái
    'VV': 'V', 'WW': 'W', 'AL ': 'AL', 'SL ': 'SL',
  },

  // Vietnamese diacritics correction (OCR hay mất dấu)
  vietnameseCorrections: [
    ['Ma nhan vien', 'Mã nhân viên'],
    ['Ten nhan vien', 'Tên nhân viên'],
    ['Phong ban', 'Phòng ban'],
    ['Ngay tang ca', 'Ngày tăng ca'],
    ['So gio tang ca', 'Số giờ tăng ca'],
    ['Gio vao', 'Giờ vào'],
    ['Gio ra', 'Giờ ra'],
    ['Bang cham cong', 'Bảng chấm công'],
    ['Kiem tra chot cong', 'Kiểm tra chốt công'],
    ['Tang ca', 'Tăng ca'],
    ['Chuc vu', 'Chức vụ'],
    ['Bo phan', 'Bộ phận'],
    ['Ca lam', 'Ca làm'],
    ['Thu', 'Thứ'],
    ['Cong', 'Công'],
    ['Tong gio', 'Tổng giờ'],
    ['Tre', 'Trễ'],
    ['Som', 'Sớm'],
  ],
};

// ---------------------------------------------------------------------------
// Post-processing functions
// ---------------------------------------------------------------------------

/**
 * Trích xuất và thu gọn chuỗi về đúng chuẩn HR Key: "LEP000" hoặc "LEP000A" (ví dụ LEP170, LEP170a)
 * Chuẩn nghiệp vụ Leggett & Platt:
 * - "LEP026 WH" -> "LEP026" (loại bỏ mã bộ phận dính vào như WH, PROD, QC, Kho...)
 * - "LEP026WH" -> "LEP026" (dính liền không dấu cách)
 * - "LEP1" -> "LEP001"
 * - "LEP040" -> "LEP040"
 * - "LEPOO1" -> "LEP001" (nhầm O với 0)
 * - "LEP170" -> "LEP170"
 * - "LEP170a" -> "LEP170A" (chuẩn hóa hậu tố đơn A)
 * - "LEP170a WH" -> "LEP170A"
 * - "LEP066A" -> "LEP066A"
 * - "LP100A" -> "LEP100A"
 * - "1 LEP014 Nguyễn Văn A" -> "LEP014"
 */
export function extractCanonicalHRKey(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();

  // Khớp tiền tố LEP hoặc LP, theo sau bởi 1-4 ký tự số (hỗ trợ OCR nhầm O,o,l,i,s,z)
  // và tuỳ chọn DUY NHẤT 1 chữ cái hậu tố (A, B, C... hoặc a, b, c...)
  // Nếu sau số là 2+ chữ cái (như WH, QC, PROD, KHO) thì đó là bộ phận, KHÔNG PHẢI hậu tố MSNV
  const match = cleaned.match(
    /(?:LEP|LP)\s*([0-9OoilIszZ]{1,4})(?:\s*([A-Za-z])(?![A-Za-z0-9])|\s+([A-Za-z]{2,})|(?=[^A-Za-z0-9]|$)|([A-Za-z]{2,}))?/i
  );
  if (match) {
    const numCleaned = match[1]
      .replace(/[Oo]/g, '0')
      .replace(/[lIi]/g, '1')
      .replace(/[sS]/g, '5')
      .replace(/[zZ]/g, '2');
    const digits = numCleaned.replace(/\D/g, '');
    if (digits) {
      const num = parseInt(digits, 10);
      const padded = String(num).padStart(3, '0');
      // Chỉ chấp nhận 1 ký tự hậu tố (A-Z)
      const singleSuffix = match[2] ? match[2].toUpperCase() : '';
      return `LEP${padded}${singleSuffix}`;
    }
  }
  return null;
}

/**
 * Apply all HR RAG corrections to raw OCR text
 */
export function applyHRCorrections(text: string): string {
  let corrected = text.trim();

  // 1. Apply character-level corrections
  for (const [wrong, right] of Object.entries(HR_RAG_CONTEXT.corrections)) {
    if (corrected.includes(wrong)) {
      corrected = corrected.split(wrong).join(right);
    }
  }

  // 2. Apply Vietnamese diacritics corrections (whole phrase)
  for (const [noDiac, withDiac] of HR_RAG_CONTEXT.vietnameseCorrections) {
    const regex = new RegExp(noDiac, 'gi');
    if (regex.test(corrected)) {
      corrected = corrected.replace(regex, withDiac);
    }
  }

  // 3. Chuẩn hoá mã nhân viên về HR Key: LEP000 hoặc LEP000A
  const hrKey = extractCanonicalHRKey(corrected);
  if (hrKey && /^(?:LEP|LP)\s*[0-9OoilIszZ]{1,4}(?:\s*[A-Za-z])?(?:\s+[A-Za-z]{2,})?$/i.test(corrected)) {
    corrected = hrKey;
  }

  // 4. Normalize date format: dd-mm-yyyy → dd/mm/yyyy
  corrected = corrected.replace(/(\d{1,2})-(\d{1,2})-(\d{2,4})/g, '$1/$2/$3');

  // 5. Fix common OCR artifacts
  corrected = corrected.replace(/\s+/g, ' ').trim();

  return corrected;
}

/**
 * Classify a text value into HR field type
 */
export function classifyHRField(text: string): string {
  const cleaned = text.trim();
  
  // Ưu tiên phát hiện chuẩn HR Key: LEP000 hoặc LEP000text
  if (extractCanonicalHRKey(cleaned) && /^(?:LEP|LP)\s*[0-9OoilIszZ]{1,6}[A-Za-z0-9_-]*$/i.test(cleaned)) {
    return 'employeeId';
  }

  for (const [fieldType, pattern] of Object.entries(HR_RAG_CONTEXT.patterns)) {
    if ((pattern as RegExp).test(cleaned)) {
      return fieldType;
    }
  }
  
  return 'text';
}

/**
 * Post-process an entire OCR grid result for HR context
 */
export interface HRProcessedCell {
  text: string;
  correctedText: string;
  fieldType: string;
  confidence: number;
  wasCorrected: boolean;
}

export function processHRGrid(
  gridRows: Array<{ cells: Array<{ text: string; confidence: number }> }>
): HRProcessedCell[][] {
  return gridRows.map(row =>
    row.cells.map(cell => {
      const correctedText = applyHRCorrections(cell.text);
      const fieldType = classifyHRField(correctedText);
      return {
        text: cell.text,
        correctedText,
        fieldType,
        confidence: cell.confidence,
        wasCorrected: cell.text !== correctedText,
      };
    })
  );
}

/**
 * Extract structured attendance record from a processed row
 */
export interface AttendanceRecord {
  employeeId: string;
  name: string;
  date: string;
  checkIn: string;
  checkOut: string;
  shift: string;
  status: string;
  overtimeHours: number;
}

export function extractAttendanceRecord(
  processedCells: HRProcessedCell[]
): Partial<AttendanceRecord> {
  const record: Partial<AttendanceRecord> = {};
  
  for (const cell of processedCells) {
    switch (cell.fieldType) {
      case 'employeeId':
        record.employeeId = extractCanonicalHRKey(cell.correctedText) || cell.correctedText;
        break;
      case 'date': record.date = cell.correctedText; break;
      case 'time':
        if (!record.checkIn) record.checkIn = cell.correctedText;
        else if (!record.checkOut) record.checkOut = cell.correctedText;
        break;
      case 'shift': record.shift = cell.correctedText; break;
      case 'status': record.status = cell.correctedText; break;
      case 'overtimeHours': record.overtimeHours = parseFloat(cell.correctedText) || 0; break;
      default:
        if (!record.name && cell.correctedText.length > 2 && !/^\d+$/.test(cell.correctedText)) {
          record.name = cell.correctedText;
        }
        break;
    }
  }
  
  return record;
}
