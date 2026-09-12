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

export function parseExcelDate(rawDate: any): string {
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
  // 3. String (DD/MM/YYYY or YYYY-MM-DD)
  if (typeof rawDate === 'string' && rawDate.trim()) {
    const clean = rawDate.trim();
    const isoMatch = clean.match(/^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
    }
    const ddmmyyyyMatch = clean.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{4})/);
    if (ddmmyyyyMatch) {
      return `${ddmmyyyyMatch[3]}-${ddmmyyyyMatch[2].padStart(2, '0')}-${ddmmyyyyMatch[1].padStart(2, '0')}`;
    }
  }
  return '';
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

  // Tự động nhận diện dòng tiêu đề (Header row) linh hoạt
  let headerRowIndex = -1;
  const colMap = {
    empId: 1,
    fullName: 2,
    departmentCode: 3,
    date: 4,
    dayOfWeek: 5,
    checkIn: 6,
    checkOut: 7,
    lateMins: 8,
    earlyMins: 9,
    workUnits: 10,
    totalHours: 11,
    otHours: 12,
    shift: 14
  };

  for (let r = 0; r < Math.min(10, rows.length); r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const rowStr = row.map(c => String(c || '').toLowerCase().trim());
    const hasEmp = rowStr.some(c => c.includes('mã nhân viên') || c.includes('mã nv') || c.includes('ma nhan vien') || c.includes('ma nv') || c.includes('employee'));
    const hasDate = rowStr.some(c => c.includes('ngày') || c.includes('ngay') || c === 'date');
    if (hasEmp && hasDate) {
      headerRowIndex = r;
      rowStr.forEach((h, idx) => {
        if (h.includes('mã nhân viên') || h.includes('mã nv') || h.includes('ma nhan vien') || h.includes('ma nv') || h.includes('employee')) colMap.empId = idx;
        else if (h.includes('tên nhân viên') || h.includes('họ và tên') || h.includes('ho va ten') || h.includes('name')) colMap.fullName = idx;
        else if (h.includes('phòng ban') || h.includes('bộ phận') || h.includes('phong ban') || h.includes('dept')) colMap.departmentCode = idx;
        else if (h.includes('ngày') || h.includes('ngay') || h === 'date') colMap.date = idx;
        else if (h.includes('thứ') || h.includes('thu') || h === 'day') colMap.dayOfWeek = idx;
        else if (h.includes('giờ vào') || h.includes('gio vao') || h.includes('vào') || h === 'in') colMap.checkIn = idx;
        else if (h.includes('giờ ra') || h.includes('gio ra') || h.includes('ra') || h === 'out') colMap.checkOut = idx;
        else if (h.includes('trễ') || h.includes('tre') || h.includes('late')) colMap.lateMins = idx;
        else if (h.includes('sớm') || h.includes('som') || h.includes('early')) colMap.earlyMins = idx;
        else if (h.includes('công') || h.includes('cong')) colMap.workUnits = idx;
        else if (h.includes('tổng giờ') || h.includes('tong gio')) colMap.totalHours = idx;
        else if (h.includes('tăng ca') || h.includes('tang ca') || h.includes('ot')) colMap.otHours = idx;
        else if (h === 'ca' || h.includes('shift') || h.includes('ca làm')) colMap.shift = idx;
      });
      break;
    }
  }

  const dataRows = headerRowIndex >= 0 ? rows.slice(headerRowIndex + 1) : rows.slice(3);
  const totalRows = dataRows.length;

  onProgress?.(30, `Tìm thấy ${totalRows.toLocaleString()} dòng quẹt thẻ. Đang chuẩn hóa dữ liệu...`);
  await new Promise(r => setTimeout(r, 0));

  const rawLogs: any[] = [];
  const timesheetMap = new Map<string, any>();
  const overtimeMap = new Map<string, any>();
  let minDate = '';
  let maxDate = '';

  const chunkSize = 2000;
  for (let i = 0; i < totalRows; i++) {
    const row = dataRows[i];
    if (!row) continue;

    const empId = String(row[colMap.empId] || '').trim();
    if (!empId) continue; // Require Mã Nhân Viên

    // Parse date chuẩn xác không bị lệch múi giờ
    const dateStr = parseExcelDate(row[colMap.date]);
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
    const isSunday = dayOfWeek === 'CN' || dayOfWeek.toLowerCase().includes('sun') || dayOfWeek === 'Chủ nhật';

    if (!checkIn && !checkOut) {
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
    if (statusCode === 'MCO') violationNote = `Chỉ có giờ ra, không có giờ vào (quẹt ra: ${checkOut})`;
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

    const isViolation = statusCode === 'LA' || statusCode === 'ED' || statusCode === 'MCO' || statusCode === 'MCI' || statusCode === 'OFF';

    const key = `${empId}_${dateStr}`;
    timesheetMap.set(key, {
      employeeId_date: key,
      employeeId: empId,
      date: dateStr,
      dayIndex: parseInt(dateStr.split('-')[2], 10),
      statusCode,
      checkIn,
      checkOut,
      lateMinutes: lateMins,
      earlyMinutes: earlyMins,
      isViolation,
      isViolationFlag: isViolation ? 1 : 0,
      violationNote,
      calculatedOvertime: otHours,
      month,
      year
    });

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
    detectedPeriod
  };
}
