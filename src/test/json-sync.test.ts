import { describe, it, expect } from 'vitest';
import {
  mergeTableRecords,
  mergeQualityRates,
  mergeEmployeesSafe,
  unionById,
  validateDeptPayload,
  validateMasterPayload,
  tieBreakWinner,
  getRecordStamp,
} from '../services/json-sync-service';

describe('json-sync LWW + tie-break kieu>hoa (phương án A)', () => {
  it('bản mới hơn thắng, bản cũ hơn bị skip', () => {
    const local = [{ employeeId_date: 'LEP001_2026-09-01', shiftCode: 'SHIFT_1', _sync: { at: '2026-09-10T00:00:00.000Z', by: 'hoa' } }];
    const incoming = [{ employeeId_date: 'LEP001_2026-09-01', shiftCode: 'SHIFT_2', _sync: { at: '2026-09-12T00:00:00.000Z', by: 'kieu' } }];
    const r = mergeTableRecords('shiftRosters', local, incoming, (x: any) => x.employeeId_date, {
      exportedAt: '2026-09-12T00:00:00.000Z',
      exportedBy: 'kieu',
    });
    expect(r.applied).toBe(1);
    expect(r.toPut[0].shiftCode).toBe('SHIFT_2');
  });

  it('cùng mốc giờ thì kieu thắng hoa', () => {
    expect(tieBreakWinner('kieu', 'hoa')).toBe('incoming');
    expect(tieBreakWinner('hoa', 'kieu')).toBe('local');
    const at = '2026-09-12T00:00:00.000Z';
    const local = [{ employeeId_date: 'X', v: 1, _sync: { at, by: 'hoa' } }];
    const incoming = [{ employeeId_date: 'X', v: 2, _sync: { at, by: 'kieu' } }];
    const r = mergeTableRecords('t', local, incoming, (x: any) => x.employeeId_date, { exportedAt: at, exportedBy: 'kieu' });
    expect(r.applied).toBe(1);
    expect(r.conflicts.length).toBe(1);
  });

  it('rates merge theo field: han sửa NS + nguyetanh sửa CL cùng record đều giữ', () => {
    const local = [
      { lineId_date: 'L_2026-09-01', productivityRate: 120, qualityRate: 98, _syncNS: { at: '2026-09-11T00:00:00Z', by: 'han', field: 'NS' }, _syncCL: { at: '2026-09-10T00:00:00Z', by: 'nguyetanh', field: 'CL' } },
    ];
    const incoming = [
      { lineId_date: 'L_2026-09-01', productivityRate: 100, qualityRate: 90, _syncNS: { at: '2026-09-09T00:00:00Z', by: 'han', field: 'NS' }, _syncCL: { at: '2026-09-12T00:00:00Z', by: 'nguyetanh', field: 'CL' } },
    ];
    const r = mergeQualityRates(local as any, incoming as any, { exportedAt: '2026-09-12T00:00:00Z', exportedBy: 'nguyetanh' });
    expect(r.applied).toBe(1);
    // NS giữ bản han mới hơn (120), CL lấy bản nguyetanh mới hơn (90)
    expect(r.toPut[0].productivityRate).toBe(120);
    expect(r.toPut[0].qualityRate).toBe(90);
  });
});

describe('an toàn NV cũ/mới', () => {
  it('NV mới trùng erpId bị chặn', () => {
    const local = [{ employeeId: 'LEP001', fullName: 'Nguyen A', erpId: '1001' }];
    const incoming = [{ employeeId: 'LEP999', fullName: 'Nguyen Fake', erpId: '1001' }];
    const r = mergeEmployeesSafe(local as any, incoming as any, { exportedAt: new Date().toISOString(), exportedBy: 'hoa' });
    expect(r.blocked.length).toBe(1);
    expect(r.applied).toBe(0);
  });

  it('NV mới hợp lệ được thêm', () => {
    const local = [{ employeeId: 'LEP001', fullName: 'Nguyen A', erpId: '1001' }];
    const incoming = [
      { employeeId: 'LEP001', fullName: 'Nguyen A', erpId: '1001' },
      { employeeId: 'LEP002', fullName: 'Tran B', erpId: '1002' },
    ];
    const r = mergeEmployeesSafe(local as any, incoming as any, { exportedAt: new Date().toISOString(), exportedBy: 'kieu' });
    expect(r.applied).toBe(1);
    expect(r.toPut[0].employeeId).toBe('LEP002');
  });

  it('union audit không trùng id', () => {
    const { merged, added } = unionById(
      [{ id: 'LOG_1' }, { id: 'LOG_2' }],
      [{ id: 'LOG_2' }, { id: 'LOG_3' }],
      (r: any) => r.id
    );
    expect(added).toBe(1);
    expect(merged.length).toBe(3);
  });

  it('dept sai scope bị validate bắt', () => {
    expect(() =>
      validateDeptPayload({ kind: 'dept', department: 'IT', owner: 'vinh', shiftRosters: [] })
    ).toThrow();
    const ok = validateDeptPayload({ kind: 'dept', department: 'WH', owner: 'vinh', exportedBy: 'vinh', shiftRosters: [], productivityQualityRates: [] });
    expect(ok.department).toBe('WH');
  });

  it('master thiếu kind bị từ chối', () => {
    expect(() => validateMasterPayload({ employees: [] })).toThrow();
  });

  it('getRecordStamp ưu tiên _sync.at', () => {
    const t = getRecordStamp({ _sync: { at: '2026-09-12T00:00:00.000Z', by: 'kieu' }, updatedAt: '2026-01-01T00:00:00.000Z' }, '2026-01-02T00:00:00.000Z');
    expect(t).toBe(Date.parse('2026-09-12T00:00:00.000Z'));
  });
});
