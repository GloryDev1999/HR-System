import type { IDailyTimesheetCell, IEmployee, ILeaveRequest, IOvertimeRecord } from '../types';

/**
 * day-hours — logic hiển thị 3 cột/ngày của Bảng chấm công (gộp Overtime Table).
 *
 * Cột 1 (giờ làm): số giờ thực tế suy từ quẹt vào/ra.
 *   - Ca hành chính (OFFICE_M_S / OFFICE_M_F, 07:30-16:00) TRỪ 30' nghỉ trưa.
 *   - Ca 1 / Ca 2 KHÔNG trừ. Trần = 8h (phần dư tính vào tăng ca riêng).
 *   - Đủ 8 → xanh · 6–7.9 → cam · <6 → đỏ nhấp nháy.
 * Cột 2 (phép): số giờ thiếu + mã phép, suy từ leaveRequests (PENDING→Off,
 *   APPROVED→loại phép được duyệt, REJECTED→Off) hoặc từ mã ô công.
 * Cột 3 (tăng ca): giữ nguyên bản ghi overtime_records (PENDING/MATCHED/MISMATCH).
 */

export const STANDARD_HOURS = 8;

export function parseTimeToMinutes(t?: string | null): number | null {
  if (!t || typeof t !== 'string') return null;
  const p = t.trim().split(':');
  if (p.length < 2) return null;
  const h = parseInt(p[0], 10);
  const m = parseInt(p[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

/** Ca hành chính trừ 30' trưa; Ca 1/2 không trừ. */
export function isOfficeShift(shiftClassId?: string | null): boolean {
  return shiftClassId === 'OFFICE_M_S' || shiftClassId === 'OFFICE_M_F';
}

/**
 * Giờ làm thực tế từ quẹt thẻ. null = không đủ dữ liệu quẹt.
 * VD hành chính 07:30→16:00 = 510' − 30' = 480' = 8h;
 * 07:30→12:00 = 270' − 30' = 240' = 4h.
 */
export function computeWorkedHours(
  checkIn?: string | null,
  checkOut?: string | null,
  shiftClassId?: string | null
): number | null {
  const inM = parseTimeToMinutes(checkIn);
  const outM = parseTimeToMinutes(checkOut);
  if (inM === null || outM === null || outM <= inM) return null;
  let mins = outM - inM;
  if (isOfficeShift(shiftClassId)) mins -= 30;
  if (mins < 0) mins = 0;
  const hours = Math.min(STANDARD_HOURS, Math.round((mins / 60) * 10) / 10);
  return hours;
}

export type WorkedTone = 'full' | 'warn' | 'low';

/** 8 xanh · 6–7.9 cam · <6 đỏ nhấp nháy. */
export function workedTone(hours: number): WorkedTone {
  if (hours >= STANDARD_HOURS) return 'full';
  if (hours >= 6) return 'warn';
  return 'low';
}

/** '8' thay vì '8.0'; '7.5' giữ nguyên. */
export function formatHours(v: number): string {
  return v % 1 === 0 ? String(v) : String(Math.round(v * 10) / 10);
}

function parseClockToMinutes(t?: string | null): number | null {
  if (!t || typeof t !== 'string') return null;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (isNaN(h) || isNaN(min)) return null;
  return h * 60 + min;
}

/**
 * QUY TẮC PUNCH ĐƠN (KB-027): máy chấm công dồn giờ chấm duy nhất vào cột Giờ vào.
 * Gốc LEP → ca cố định (start/end, đã ưu tiên sắp ca ở caller) → giờ chấm gần đầu ca
 * là giờ VÀO (thiếu ra → MCO), gần cuối ca là giờ RA (thiếu vào → MCI).
 * VD HC 07:30-16:00 chấm duy nhất 16:00 → MCI; chấm duy nhất 07:30 → MCO.
 */
export function reclassifySinglePunch(
  single: string,
  shiftStart: string,
  shiftEnd: string
): { checkIn: string; checkOut: string } {
  const t = parseClockToMinutes(single);
  const s = parseClockToMinutes(shiftStart);
  const e = parseClockToMinutes(shiftEnd);
  if (t === null || s === null || e === null) return { checkIn: single, checkOut: '' };
  if (Math.abs(t - s) <= Math.abs(t - e)) return { checkIn: single, checkOut: '' };
  return { checkIn: '', checkOut: single };
}

const FULL_LEAVE_CODES = new Set(['AL', 'UL', 'SL', 'PL', 'PH', 'ML', 'MATERNITY LEAVE', 'BT', 'WO']);

export interface LeaveDisplay {
  text: string; // VD '4Off', '8AL', '4UL'
  tone: 'pending' | 'approved' | 'rejected' | 'manual';
  leaveType: string;
  hours: number;
}

/** Mã hiển thị rút gọn cho loại phép (MATERNITY → ML). */
export function shortLeaveCode(t: string): string {
  if (t === 'MATERNITY' || t === 'MATERNITY LEAVE') return 'ML';
  if (t === 'UNAUTHORIZED') return 'Off';
  return t;
}

function approvedTone(t: string): LeaveDisplay['tone'] {
  return t === 'UNAUTHORIZED' ? 'rejected' : 'approved';
}

/**
 * Cột 2 (phép) của 1 ngày. null = không có giờ phép (hiển thị '–').
 * Ưu tiên: leaveRequests (trạng thái duyệt) → mã ô công (AL/UL/…/W4/AL4).
 */
export function getLeaveDisplay(
  cell: IDailyTimesheetCell | undefined,
  leaveReq: ILeaveRequest | undefined
): LeaveDisplay | null {
  if (leaveReq) {
    const missed = leaveReq.missedHours ?? Math.max(0, Math.round((leaveReq.durationDays || 0) * 8 * 10) / 10) ?? STANDARD_HOURS;
    const hours = Math.max(0, Math.min(STANDARD_HOURS, missed));
    if (leaveReq.status === 'PENDING') {
      return { text: `${formatHours(hours)}Off`, tone: 'pending', leaveType: 'Off', hours };
    }
    if (leaveReq.status === 'APPROVED') {
      const code = shortLeaveCode(leaveReq.leaveType || 'UL');
      return { text: `${formatHours(hours)}${code}`, tone: approvedTone(leaveReq.leaveType || 'UL'), leaveType: code, hours };
    }
    return { text: `${formatHours(hours)}Off`, tone: 'rejected', leaveType: 'Off', hours };
  }

  const code = (cell?.statusCode || '').trim();
  if (!code) return null;
  if (FULL_LEAVE_CODES.has(code)) {
    const short = shortLeaveCode(code);
    return { text: `${STANDARD_HOURS}${short}`, tone: 'manual', leaveType: short, hours: STANDARD_HOURS };
  }
  // Dạng nửa ngày W4/AL4, W6/UL2... (ô công chốt từ menu bù phép)
  const m = code.match(/^W(\d+(?:\.\d+)?)\/([A-Za-z]+)(\d+(?:\.\d+)?)$/);
  if (m) {
    const leaveH = parseFloat(m[3]);
    const short = shortLeaveCode(m[2].toUpperCase());
    return { text: `${formatHours(leaveH)}${short}`, tone: 'manual', leaveType: short, hours: leaveH };
  }
  return null;
}

export interface DayParts {
  /** null = hiển thị '–' */
  worked: number | null;
  workedTone: WorkedTone | null;
  /** Nghỉ cả ngày hợp lệ (phép đã duyệt / mã tay) → cột 1 xám, không cảnh báo */
  isFullLegalLeave: boolean;
  leave: LeaveDisplay | null;
  ot: IOvertimeRecord | null;
}

/** Tổng hợp 3 cột hiển thị cho 1 ô ngày. Tính toán thuần túy, không ghi DB. */
export function getDayParts(
  emp: IEmployee,
  cell: IDailyTimesheetCell | undefined,
  ot: IOvertimeRecord | null | undefined,
  leaveReq: ILeaveRequest | undefined,
  isSunday: boolean
): DayParts {
  const code = (cell?.statusCode || '').trim();

  // Chủ nhật: không chấm công, chỉ còn tăng ca (logic OT giữ nguyên)
  if (isSunday) {
    return { worked: null, workedTone: null, isFullLegalLeave: false, leave: null, ot: ot ?? null };
  }

  const leave = getLeaveDisplay(cell, leaveReq);
  let worked: number | null = computeWorkedHours(cell?.checkIn, cell?.checkOut, emp.shiftClassId);

  if (worked === null) {
    if (code === 'W' || code === 'N') worked = STANDARD_HOURS;
    else if (code === 'OFF' || code === 'Off') worked = 0;
    else if (leave && leave.hours >= STANDARD_HOURS) worked = 0;
    else if (leave) worked = Math.max(0, STANDARD_HOURS - leave.hours);
    else {
      const wm = code.match(/^W(\d+(?:\.\d+)?)\//);
      if (wm) worked = parseFloat(wm[1]);
    }
  }

  const isFullLegalLeave =
    worked === 0 && !!leave && leave.hours >= STANDARD_HOURS &&
    (leave.tone === 'approved' || leave.tone === 'manual');
  return {
    worked,
    workedTone: worked === null ? null : workedTone(worked),
    isFullLegalLeave,
    leave,
    ot: ot ?? null,
  };
}
