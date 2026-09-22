import { describe, it, expect } from 'vitest';
import {
  diffTimesheets,
  diffOvertimes,
  diffRawLogs,
  diffLeaves,
  sanitizeLeaveForDb,
} from '../services/import-diff';

const ts = (over: any) => ({
  employeeId_date: `${over.employeeId}_${over.date}`,
  checkIn: '',
  checkOut: '',
  statusCode: 'W',
  lateMinutes: 0,
  earlyMinutes: 0,
  ...over,
});

describe('import-diff: ô công', () => {
  it('mới / khớp / thay đổi từng field', () => {
    const existing = [
      ts({ employeeId: 'LEP001', date: '2026-09-21', checkIn: '07:30', checkOut: '16:00', statusCode: 'W' }),
      ts({ employeeId: 'LEP001', date: '2026-09-22', checkIn: '07:30', checkOut: '16:00', statusCode: 'W' }),
    ];
    const incoming = [
      ts({ employeeId: 'LEP001', date: '2026-09-21', checkIn: '07:30', checkOut: '16:00', statusCode: 'W' }),
      ts({ employeeId: 'LEP001', date: '2026-09-22', checkIn: '07:45', checkOut: '16:00', statusCode: 'LA' }),
      ts({ employeeId: 'LEP001', date: '2026-09-23', checkIn: '07:30', checkOut: '16:00', statusCode: 'W' }),
    ];
    const { added, changed } = diffTimesheets(existing, incoming);
    expect(added.map(r => r.date)).toEqual(['2026-09-23']);
    expect(changed).toHaveLength(1);
    expect(changed[0].conflicts.map(c => c.field).sort()).toEqual(['checkIn', 'statusCode']);
    expect(changed[0].conflicts.find(c => c.field === 'checkIn')).toMatchObject({ oldVal: '07:30', newVal: '07:45' });
  });

  it('trùng PK trong file chỉ tính 1 lần', () => {
    const rec = ts({ employeeId: 'LEP001', date: '2026-09-21' });
    const { added } = diffTimesheets([], [rec, { ...rec }]);
    expect(added).toHaveLength(1);
  });
});

describe('import-diff: tăng ca bảo tồn đối soát', () => {
  const ot = (over: any) => ({
    employeeId_date: `${over.employeeId}_${over.date}`,
    hours: 1,
    verificationStatus: 'PENDING',
    ...over,
  });
  it('MATCHED/MISMATCH giữ nguyên, PENDING khác thì changed', () => {
    const existing = [
      ot({ employeeId: 'A', date: '2026-09-21', hours: 2, verificationStatus: 'MATCHED' }),
      ot({ employeeId: 'A', date: '2026-09-22', hours: 1, verificationStatus: 'PENDING' }),
    ];
    const incoming = [
      ot({ employeeId: 'A', date: '2026-09-21', hours: 2.5, verificationStatus: 'PENDING' }),
      ot({ employeeId: 'A', date: '2026-09-22', hours: 1.5, verificationStatus: 'PENDING' }),
      ot({ employeeId: 'A', date: '2026-09-23', hours: 1, verificationStatus: 'PENDING' }),
    ];
    const { added, changed, preserved } = diffOvertimes(existing, incoming);
    expect(added.map(r => r.date)).toEqual(['2026-09-23']);
    expect(changed.map(c => c.record.date)).toEqual(['2026-09-22']);
    expect(preserved).toBe(1);
  });
});

describe('import-diff: quẹt thô append-only', () => {
  it('trùng khóa tự nhiên thì bỏ', () => {
    const existing = [{ employeeId: 'A', date: '2026-09-21', checkIn: '07:30', checkOut: '16:00' }];
    const incoming = [
      { employeeId: 'A', date: '2026-09-21', checkIn: '07:30', checkOut: '16:00' },
      { employeeId: 'A', date: '2026-09-22', checkIn: '07:30', checkOut: '16:00' },
    ];
    expect(diffRawLogs(existing, incoming)).toHaveLength(1);
  });
});

describe('import-diff: phép + UUID', () => {
  it('bỏ id LEAVE_* lạ, DB tự sinh; dedupe theo khóa tự nhiên', () => {
    expect(sanitizeLeaveForDb({ id: 'LEAVE_A_2026-09-21', a: 1 } as any)).toEqual({ a: 1 });
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(sanitizeLeaveForDb({ id: uuid, a: 1 } as any)).toEqual({ id: uuid, a: 1 });
  });

  it('trùng NV+ngày+loại+giờ+trạng thái thì bỏ', () => {
    const existing = [{ employeeId: 'A', date: '2026-09-21', leaveType: 'AL', missedHours: 8, status: 'PENDING' }];
    const incoming = [
      { id: 'LEAVE_A_2026-09-21', employeeId: 'A', date: '2026-09-21', leaveType: 'AL', missedHours: 8, status: 'PENDING' },
      { employeeId: 'A', date: '2026-09-22', leaveType: 'AL', missedHours: 8, status: 'PENDING' },
    ];
    const added = diffLeaves(existing, incoming);
    expect(added).toHaveLength(1);
    expect(added[0].id).toBeUndefined();
  });
});
