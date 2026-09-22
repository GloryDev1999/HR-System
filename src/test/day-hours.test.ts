import { describe, it, expect } from 'vitest';
import {
  computeWorkedHours,
  workedTone,
  formatHours,
  getLeaveDisplay,
  getDayParts,
  isOfficeShift,
  reclassifySinglePunch,
} from '../services/day-hours';
import type { IDailyTimesheetCell, IEmployee, ILeaveRequest } from '../types';

const empHC = { employeeId: 'LEP001', shiftClassId: 'OFFICE_M_S' } as IEmployee;
const empS1 = { employeeId: 'LEP002', shiftClassId: 'SHIFT_1' } as IEmployee;

const cell = (over: Partial<IDailyTimesheetCell>): IDailyTimesheetCell =>
  ({
    employeeId_date: 'LEP001_2026-08-01',
    employeeId: 'LEP001',
    date: '2026-08-01',
    dayIndex: 1,
    statusCode: 'W',
    calculatedOvertime: 0,
    month: 8,
    year: 2026,
    ...over,
  } as IDailyTimesheetCell);

describe('day-hours: giờ làm thực tế', () => {
  it('HC 07:30-16:00 trừ 30p = 8h', () => {
    expect(computeWorkedHours('07:30', '16:00', 'OFFICE_M_S')).toBe(8);
  });

  it('HC 07:30-12:00 trừ 30p = 4h', () => {
    expect(computeWorkedHours('07:30', '12:00', 'OFFICE_M_S')).toBe(4);
  });

  it('OFFICE_M_F cũng trừ 30p', () => {
    expect(isOfficeShift('OFFICE_M_F')).toBe(true);
    expect(computeWorkedHours('07:30', '16:00', 'OFFICE_M_F')).toBe(8);
  });

  it('Ca 1 06:00-14:00 không trừ = 8h', () => {
    expect(computeWorkedHours('06:00', '14:00', 'SHIFT_1')).toBe(8);
  });

  it('Ca 2 không trừ 30p', () => {
    expect(isOfficeShift('SHIFT_2')).toBe(false);
    expect(computeWorkedHours('14:00', '22:00', 'SHIFT_2')).toBe(8);
  });

  it('trần 8h (phần dư là tăng ca riêng)', () => {
    expect(computeWorkedHours('06:00', '17:00', 'SHIFT_1')).toBe(8);
  });

  it('thiếu quẹt → null', () => {
    expect(computeWorkedHours('07:30', undefined, 'OFFICE_M_S')).toBeNull();
    expect(computeWorkedHours(undefined, '16:00', 'OFFICE_M_S')).toBeNull();
  });

  it('ngưỡng màu: 8 xanh, 6-7.9 cam, <6 đỏ', () => {
    expect(workedTone(8)).toBe('full');
    expect(workedTone(7.5)).toBe('warn');
    expect(workedTone(6)).toBe('warn');
    expect(workedTone(5.9)).toBe('low');
    expect(workedTone(0)).toBe('low');
  });

  it('formatHours: 8 không hiện .0', () => {
    expect(formatHours(8)).toBe('8');
    expect(formatHours(7.5)).toBe('7.5');
  });
});

describe('day-hours: cột phép', () => {
  const req = (over: Partial<ILeaveRequest>): ILeaveRequest =>
    ({
      id: 'LEAVE_LEP001_2026-08-01',
      employeeId: 'LEP001',
      fullName: 'Test',
      department: 'Production',
      date: '2026-08-01',
      leaveType: 'AL',
      durationDays: 0.5,
      missedHours: 4,
      workedHours: 4,
      status: 'PENDING',
      ...over,
    } as ILeaveRequest);

  it('PENDING → 4Off', () => {
    const d = getLeaveDisplay(cell({ statusCode: 'OFF' }), req({ status: 'PENDING' }));
    expect(d?.text).toBe('4Off');
    expect(d?.tone).toBe('pending');
  });

  it('APPROVED AL → 4AL', () => {
    const d = getLeaveDisplay(cell({ statusCode: 'W4/AL4' }), req({ status: 'APPROVED', leaveType: 'AL' }));
    expect(d?.text).toBe('4AL');
    expect(d?.tone).toBe('approved');
  });

  it('REJECTED → Off đỏ', () => {
    const d = getLeaveDisplay(cell({ statusCode: 'Off' }), req({ status: 'REJECTED' }));
    expect(d?.text).toBe('4Off');
    expect(d?.tone).toBe('rejected');
  });

  it('mã tay AL cả ngày → 8AL (không cần request)', () => {
    const d = getLeaveDisplay(cell({ statusCode: 'AL' }), undefined);
    expect(d?.text).toBe('8AL');
  });

  it('mã W4/AL4 → 4AL', () => {
    const d = getLeaveDisplay(cell({ statusCode: 'W4/AL4' }), undefined);
    expect(d?.text).toBe('4AL');
  });

  it('ngày W bình thường → null', () => {
    expect(getLeaveDisplay(cell({ statusCode: 'W' }), undefined)).toBeNull();
  });
});

describe('day-hours: getDayParts', () => {
  it('Chủ nhật chỉ còn OT', () => {
    const p = getDayParts(empHC, cell({ statusCode: '' }), null, undefined, true);
    expect(p.worked).toBeNull();
    expect(p.leave).toBeNull();
  });

  it('W đủ quẹt HC → 8 full', () => {
    const p = getDayParts(
      empHC,
      cell({ statusCode: 'W', checkIn: '07:30', checkOut: '16:00' }),
      null,
      undefined,
      false
    );
    expect(p.worked).toBe(8);
    expect(p.workedTone).toBe('full');
  });

  it('nửa ngày HC → 4 warn/mid', () => {
    const p = getDayParts(
      empHC,
      cell({ statusCode: 'LA', checkIn: '07:30', checkOut: '12:00' }),
      null,
      undefined,
      false
    );
    expect(p.worked).toBe(4);
    expect(p.workedTone).toBe('low');
  });

  it('AL cả ngày duyệt → cột 1 xám hợp lệ', () => {
    const p = getDayParts(empHC, cell({ statusCode: 'AL' }), null, undefined, false);
    expect(p.worked).toBe(0);
    expect(p.isFullLegalLeave).toBe(true);
  });

  it('Ca 1 đủ quẹt → 8', () => {
    const p = getDayParts(
      empS1,
      cell({ statusCode: 'W', checkIn: '06:00', checkOut: '14:00' }),
      null,
      undefined,
      false
    );
    expect(p.worked).toBe(8);
  });
});

describe('day-hours: quy tắc punch đơn (KB-027)', () => {
  it('HC chấm duy nhất 16:00 → giờ RA (thiếu vào, MCI)', () => {
    expect(reclassifySinglePunch('16:00', '07:30', '16:00')).toEqual({ checkIn: '', checkOut: '16:00' });
  });

  it('HC chấm duy nhất 07:30 → giờ VÀO (thiếu ra, MCO)', () => {
    expect(reclassifySinglePunch('07:30', '07:30', '16:00')).toEqual({ checkIn: '07:30', checkOut: '' });
  });

  it('HC chấm duy nhất 07:25 (đi sớm) → giờ VÀO', () => {
    expect(reclassifySinglePunch('07:25', '07:30', '16:00')).toEqual({ checkIn: '07:25', checkOut: '' });
  });

  it('Ca 2 (14:00-22:00) chấm duy nhất 14:05 → giờ VÀO', () => {
    expect(reclassifySinglePunch('14:05', '14:00', '22:00')).toEqual({ checkIn: '14:05', checkOut: '' });
  });

  it('Ca 2 chấm duy nhất 21:50 → giờ RA', () => {
    expect(reclassifySinglePunch('21:50', '14:00', '22:00')).toEqual({ checkIn: '', checkOut: '21:50' });
  });

  it('giờ/ca lỗi → giữ nguyên cột vào (an toàn)', () => {
    expect(reclassifySinglePunch('abc', '07:30', '16:00')).toEqual({ checkIn: 'abc', checkOut: '' });
  });
});
