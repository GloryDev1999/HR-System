import { describe, it, expect } from 'vitest';
import { snakeToCamel, convertRowToCamel } from '../lib/tables';
import { DEFAULT_SETTINGS } from '../lib/defaultSettings';

describe('Supabase tables mapper (thay Dexie stores)', () => {
  it('snake_case -> camelCase cho mọi cột', () => {
    expect(snakeToCamel('employee_id')).toBe('employeeId');
    expect(snakeToCamel('employee_id_date')).toBe('employeeIdDate');
    expect(snakeToCamel('is_violation')).toBe('isViolation');
    expect(snakeToCamel('display_name')).toBe('displayName');
    expect(snakeToCamel('department_scope')).toBe('departmentScope');
    expect(snakeToCamel('line_id_date')).toBe('lineIdDate');
  });

  it('convertRowToCamel tỉa TIME HH:mm:ss về HH:mm', () => {
    const row = convertRowToCamel({
      employee_id: 'LEP010',
      check_in: '06:05:00',
      check_out: '14:00:00',
      start_time: '07:30:00',
      date: '2026-08-01',
    });
    expect(row.employeeId).toBe('LEP010');
    expect(row.checkIn).toBe('06:05');
    expect(row.checkOut).toBe('14:00');
    expect(row.startTime).toBe('07:30');
    expect(row.date).toBe('2026-08-01');
  });

  it('convertRowToCamel alias created_at -> timestamp cho audit logs', () => {
    const row = convertRowToCamel({ id: 'LOG_1', created_at: '2026-09-21T00:00:00Z' });
    expect(row.createdAt).toBe('2026-09-21T00:00:00Z');
    expect(row.timestamp).toBe('2026-09-21T00:00:00Z');
  });

  it('rolePermissions mặc định giữ đủ 6 vai trò', () => {
    const roles = Object.keys(DEFAULT_SETTINGS.rolePermissions);
    expect(roles).toHaveLength(6);
    expect(roles).toContain('AD System');
    expect(roles).toContain('HR Manager');
  });
});
