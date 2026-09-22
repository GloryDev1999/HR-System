import { describe, it, expect } from 'vitest';
import { clusterOf, CLUSTER_META } from '../pages/TimesheetCalendarPage';
import type { IEmployee } from '../types';

const emp = (over: Partial<IEmployee>): IEmployee =>
  ({
    employeeId: 'LEPX',
    fullName: 'Test',
    department: 'Production',
    position: 'Operator',
    startDate: '01/01/2026',
    contractType: 'OFFICIAL',
    shiftClassId: 'OFFICE_M_S',
    customAllowances: {},
    annualLeaveBalance: {},
    status: 'ACTIVE',
    ...over,
  } as IEmployee);

describe('timesheet clusters: HC23 / HC_CA / SEASONAL', () => {
  it('OFFICE_M_F → HC23 (23 công)', () => {
    expect(clusterOf(emp({ shiftClassId: 'OFFICE_M_F', contractType: 'OFFICIAL' }))).toBe('HC23');
  });

  it('OFFICE_M_S + SHIFT_1 + SHIFT_2 chính thức → HC_CA', () => {
    expect(clusterOf(emp({ shiftClassId: 'OFFICE_M_S' }))).toBe('HC_CA');
    expect(clusterOf(emp({ shiftClassId: 'SHIFT_1' }))).toBe('HC_CA');
    expect(clusterOf(emp({ shiftClassId: 'SHIFT_2' }))).toBe('HC_CA');
  });

  it('SEASONAL mọi ca → SEASONAL (kể cả SHIFT_1/OFFICE_M_F)', () => {
    expect(clusterOf(emp({ contractType: 'SEASONAL', shiftClassId: 'SHIFT_1' }))).toBe('SEASONAL');
    expect(clusterOf(emp({ contractType: 'SEASONAL', shiftClassId: 'OFFICE_M_F' }))).toBe('SEASONAL');
    expect(clusterOf(emp({ contractType: 'SEASONAL', shiftClassId: 'OFFICE_M_S' }))).toBe('SEASONAL');
  });

  it('chu kỳ theo cụm: HC dùng 21-20, thời vụ dùng 1-31', () => {
    expect(CLUSTER_META.HC23.cycle).toBe('OFFICIAL');
    expect(CLUSTER_META.HC_CA.cycle).toBe('OFFICIAL');
    expect(CLUSTER_META.SEASONAL.cycle).toBe('SEASONAL');
  });
});
