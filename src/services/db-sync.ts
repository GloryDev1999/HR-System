/**
 * Đồng bộ DB qua Snapshot JSON (OneDrive workflow)
 *
 * Nguyên tắc an toàn:
 *  - Import luôn chạy trong MỘT transaction Dexie: hỏng giữa chừng thì rollback,
 *    không bao giờ rơi vào trạng thái mất một nửa dữ liệu
 *  - Validate cấu trúc + phiên bản snapshot trước khi đụng tới dữ liệu hiện có
 *  - Bảng không có trong snapshot vẫn được xoá sạch (đúng nghĩa "thay thế"),
 *    trừ bảng accounts (tài khoản đăng nhập là dữ liệu cục bộ của từng máy)
 */
import { db } from '../db';
import { runWithoutLanPush } from './lan-push-guard';
import { 
  IEmployee, 
  IDailyTimesheetCell, 
  IOvertimeRecord, 
  ILeaveRequest, 
  IShiftRosterEntry, 
  IOCREntry, 
  ISystemSettings, 
  IShiftClass, 
  IRbacRole,
  IProductionLine,
  IProductivityQualityRate
} from '../types';
import { DEFAULT_SETTINGS } from '../db';

export const SNAPSHOT_VERSION = '3.1.0';

export interface IDatabaseSnapshot {
  version: string;
  exportedAt: string;
  exportedBy: string;
  employees: IEmployee[];
  dailyTimesheets: IDailyTimesheetCell[];
  overtimeRecords: IOvertimeRecord[];
  leaveRequests: ILeaveRequest[];
  shiftRosters: IShiftRosterEntry[];
  ocrScans: IOCREntry[];
  settings?: ISystemSettings;
  // v3: thêm master data mới — optional để tương thích snapshot v2 cũ
  shiftClasses?: IShiftClass[];
  rbacRoles?: IRbacRole[];
  // v3.1: thêm master data chuyền sản xuất & tỷ lệ năng suất chất lượng
  productionLines?: IProductionLine[];
  productivityQualityRates?: IProductivityQualityRate[];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function exportDatabaseToSnapshot(userName: string = 'HR Admin'): Promise<void> {
  const snapshot: IDatabaseSnapshot = {
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: userName,
    employees: await db.employees.toArray(),
    dailyTimesheets: await db.dailyTimesheets.toArray(),
    overtimeRecords: await db.overtimeRecords.toArray(),
    leaveRequests: await db.leaveRequests.toArray(),
    shiftRosters: await db.shiftRosters.toArray(),
    ocrScans: await db.ocrScans.toArray(),
    settings: ((await db.settings.get('systemSettings'))?.value as ISystemSettings) || undefined,
    shiftClasses: await db.shiftClasses.toArray(),
    rbacRoles: await db.rbacRoles.toArray(),
    productionLines: await db.productionLines.toArray(),
    productivityQualityRates: await db.productivityQualityRates.toArray()
  };

  const jsonStr = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `SmartHR_OneDrive_Sync_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

interface ValidatedSnapshot {
  data: Required<Pick<IDatabaseSnapshot, 'employees' | 'dailyTimesheets' | 'overtimeRecords' | 'leaveRequests' | 'shiftRosters' | 'ocrScans'>> & {
    shiftClasses: IShiftClass[];
    rbacRoles: IRbacRole[];
    productionLines: IProductionLine[];
    productivityQualityRates: IProductivityQualityRate[];
  };
  settings?: ISystemSettings;
  skipped: Record<string, number>;
}

/** Kiểm tra chặt cấu trúc - trả về bản đã lọc dòng lỗi kèm số dòng bị bỏ qua */
function validateSnapshot(raw: unknown): ValidatedSnapshot {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Tệp đồng bộ không phải JSON hợp lệ.');
  }
  const obj = raw as Record<string, unknown>;

  if (!isNonEmptyString(obj.version)) {
    throw new Error('Tệp thiếu trường "version" - không phải snapshot của hệ thống.');
  }
  const major = parseInt(obj.version.split('.')[0], 10);
  if (!Number.isFinite(major) || major < 1 || major > 3) {
    throw new Error(`Phiên bản snapshot "${obj.version}" không được hỗ trợ (hỗ trợ 1.x - 3.x).`);
  }

  const skipped: Record<string, number> = {};

  const pickArray = <T>(key: string, isValidRow: (row: T) => boolean): T[] => {
    const arr = obj[key];
    if (arr === undefined) return [];
    if (!Array.isArray(arr)) throw new Error(`Trường "${key}" phải là mảng.`);
    const valid = arr.filter((r): r is T => !!r && typeof r === 'object' && isValidRow(r as T));
    if (valid.length !== arr.length) skipped[key] = arr.length - valid.length;
    return valid;
  };

  const data = {
    employees: pickArray<IEmployee>('employees', e => isNonEmptyString(e.employeeId) && isNonEmptyString(e.fullName)),
    dailyTimesheets: pickArray<IDailyTimesheetCell>('dailyTimesheets', t => isNonEmptyString(t.employeeId_date) && isNonEmptyString(t.date)),
    overtimeRecords: pickArray<IOvertimeRecord>('overtimeRecords', o => isNonEmptyString(o.employeeId_date) && typeof o.hours === 'number'),
    leaveRequests: pickArray<ILeaveRequest>('leaveRequests', l => isNonEmptyString(l.id)),
    shiftRosters: pickArray<IShiftRosterEntry>('shiftRosters', s => isNonEmptyString(s.employeeId_date)),
    ocrScans: pickArray<IOCREntry>('ocrScans', o => isNonEmptyString(o.id)),
    shiftClasses: pickArray<IShiftClass>('shiftClasses', s => isNonEmptyString(s.shiftClassId) && isNonEmptyString(s.startTime)),
    rbacRoles: pickArray<IRbacRole>('rbacRoles', r => isNonEmptyString(r.roleId) && Array.isArray((r as any).permissions)),
    productionLines: pickArray<IProductionLine>('productionLines', p => isNonEmptyString(p.id) && isNonEmptyString(p.name)),
    productivityQualityRates: pickArray<IProductivityQualityRate>('productivityQualityRates', r => isNonEmptyString(r.lineId_date) && isNonEmptyString(r.lineId) && typeof r.productivityRate === 'number')
  };

  let settings: ISystemSettings | undefined;
  if (obj.settings && typeof obj.settings === 'object' && (obj.settings as ISystemSettings).rolePermissions) {
    // Hợp lệ hoá tối thiểu: có rolePermissions dạng object
    settings = { ...DEFAULT_SETTINGS, ...(obj.settings as ISystemSettings) };
    if (!settings.diligenceDeductionRules?.length) settings.diligenceDeductionRules = DEFAULT_SETTINGS.diligenceDeductionRules;
  }

  return { data, settings, skipped };
}

// ---------------------------------------------------------------------------
// Import (atomic)
// ---------------------------------------------------------------------------

export async function importDatabaseFromSnapshot(file: File): Promise<{
  employeesCount: number;
  timesheetsCount: number;
  overtimesCount: number;
  exportedAt: string;
  exportedBy: string;
  skippedTotal: number;
  settingsRestored: boolean;
}> {
  const text = await file.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Tệp không parse được dưới dạng JSON.');
  }

  const { data, settings, skipped } = validateSnapshot(raw);

  // v6: backfill Flag cho snapshot cũ thiếu Flag (v2 không có Flag)
  for (const r of (data as any).dailyTimesheets as any[]) if (typeof r.isViolationFlag === 'undefined') r.isViolationFlag = r.isViolation ? 1 : 0;
  for (const r of (data as any).shiftRosters as any[]) if (typeof r.isRestViolationFlag === 'undefined') r.isRestViolationFlag = r.isRestViolation ? 1 : 0;
  for (const r of (data as any).shiftClasses as any[]) if (typeof r.isRotatingFlag === 'undefined') r.isRotatingFlag = r.isRotating ? 1 : 0;
  for (const r of (data as any).rbacRoles as any[]) if (typeof r.isSystemFlag === 'undefined') r.isSystemFlag = r.isSystem ? 1 : 0;

  // Toàn bộ thay thế nằm trong một transaction - fail ở bất kỳ đâu sẽ rollback toàn bộ
  // v5: thêm shiftClasses/rbacRoles vào sync (accounts vẫn local-only không sync)
  // v7: thêm productionLines/productivityQualityRates vào sync
  // LAN push: snapshot thay thế toàn bộ DB → KHÔNG đẩy từng bản ghi lên LAN (spam).
  await runWithoutLanPush(() => db.transaction(
    'rw',
    [db.employees, db.dailyTimesheets, db.overtimeRecords, db.leaveRequests, db.shiftRosters, db.ocrScans, db.settings, db.shiftClasses, db.rbacRoles, db.productionLines, db.productivityQualityRates],
    async () => {
      await Promise.all([
        db.employees.clear(),
        db.dailyTimesheets.clear(),
        db.overtimeRecords.clear(),
        db.leaveRequests.clear(),
        db.shiftRosters.clear(),
        db.ocrScans.clear(),
        db.shiftClasses.clear(),
        db.rbacRoles.clear(),
        db.productionLines.clear(),
        db.productivityQualityRates.clear()
      ]);

      await Promise.all([
        data.employees.length && db.employees.bulkPut(data.employees),
        data.dailyTimesheets.length && db.dailyTimesheets.bulkPut(data.dailyTimesheets),
        data.overtimeRecords.length && db.overtimeRecords.bulkPut(data.overtimeRecords),
        data.leaveRequests.length && db.leaveRequests.bulkPut(data.leaveRequests),
        data.shiftRosters.length && db.shiftRosters.bulkPut(data.shiftRosters),
        data.ocrScans.length && db.ocrScans.bulkPut(data.ocrScans),
        (data as any).shiftClasses?.length && db.shiftClasses.bulkPut((data as any).shiftClasses),
        (data as any).rbacRoles?.length && db.rbacRoles.bulkPut((data as any).rbacRoles),
        (data as any).productionLines?.length && db.productionLines.bulkPut((data as any).productionLines),
        (data as any).productivityQualityRates?.length && db.productivityQualityRates.bulkPut((data as any).productivityQualityRates)
      ]);

      if (settings) {
        await db.settings.put({ key: 'systemSettings', value: settings });
      }
      // Nếu snapshot v2 cũ không có shiftClasses/rbacRoles thì re-seed mặc định để không trống
      if (!(data as any).shiftClasses?.length) {
        const scCount = await db.shiftClasses.count();
        if (scCount === 0) {
          const now = new Date().toISOString();
          await db.shiftClasses.bulkPut([
            { shiftClassId: 'OFFICE_M_F', labelVi: 'HC Văn phòng (T2-T6 | 23 công)', labelEn: 'Office Mon-Fri', startTime: '07:30', endTime: '16:00', standardWorkDays: 23, workDaysPattern: 'MON_FRI', isRotating: false, isRotatingFlag: 0, createdAt: now },
            { shiftClassId: 'OFFICE_M_S', labelVi: 'HC Chung (T2-T7 | 27 công)', labelEn: 'Office Mon-Sat', startTime: '07:30', endTime: '16:00', standardWorkDays: 27, workDaysPattern: 'MON_SAT', isRotating: false, isRotatingFlag: 0, createdAt: now },
            { shiftClassId: 'SHIFT_1', labelVi: 'Ca 1 (06:00 - 14:00)', labelEn: 'Shift 1', startTime: '06:00', endTime: '14:00', standardWorkDays: 27, workDaysPattern: 'ROTATING', isRotating: true, isRotatingFlag: 1, createdAt: now },
            { shiftClassId: 'SHIFT_2', labelVi: 'Ca 2 (14:00 - 22:00)', labelEn: 'Shift 2', startTime: '14:00', endTime: '22:00', standardWorkDays: 27, workDaysPattern: 'ROTATING', isRotating: true, isRotatingFlag: 1, createdAt: now }
          ] as any);
        }
      }
      if (!(data as any).rbacRoles?.length) {
        const rcCount = await db.rbacRoles.count();
        if (rcCount === 0) {
          const now = new Date().toISOString();
          const perms = DEFAULT_SETTINGS.rolePermissions as Record<string, string[]>;
          await db.rbacRoles.bulkPut(Object.entries(perms).map(([roleId, permissions]) => ({ roleId, roleName: roleId, permissions, isSystem: true, isSystemFlag: 1, createdAt: now })) as any);
        }
      }
      // Nếu snapshot v2/v3 cũ không có productionLines thì re-seed 2 line mặc định để không trống
      if (!(data as any).productionLines?.length) {
        const plCount = await db.productionLines.count();
        if (plCount === 0) {
          const now = new Date().toISOString();
          await db.productionLines.bulkPut([
            { id: 'line_rivet_1', name: 'Line Rivet 1', description: 'Chuyền đinh tán số 1', createdAt: now },
            { id: 'line_rivet_2', name: 'Line Rivet 2', description: 'Chuyền đinh tán số 2', createdAt: now }
          ]);
        }
      }
    }
  ));

  const skippedTotal = Object.values(skipped).reduce((s, n) => s + n, 0);

  return {
    employeesCount: data.employees.length,
    timesheetsCount: data.dailyTimesheets.length,
    overtimesCount: data.overtimeRecords.length,
    exportedAt: String((raw as IDatabaseSnapshot).exportedAt ?? ''),
    exportedBy: String((raw as IDatabaseSnapshot).exportedBy ?? ''),
    skippedTotal,
    settingsRestored: !!settings
  };
}
