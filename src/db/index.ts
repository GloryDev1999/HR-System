import Dexie, { Table } from 'dexie';
import {
  IEmployee,
  IRawAttendanceLog,
  IDailyTimesheetCell,
  IOvertimeRecord,
  ILeaveRequest,
  IShiftRosterEntry,
  IOCREntry,
  ISystemSettings,
  IAccount,
  IShiftClass,
  IRbacRole,
  IProductionLine,
  IProductivityQualityRate,
  IUserAuditLog
} from '../types';
import { emitLanPush } from '../services/lan-push-guard';

/**
 * HRSystemDatabase — Local-First IndexedDB cho SMART HR (Leggett & Platt)
 *
 * Domain: Single-File In-Browser Backend — 100% offline, không server.
 * Naming: giữ camelCase store names để không mất dữ liệu người dùng cũ
 * (SKILL quy ước snake_case nhưng đổi tên store = mất toàn bộ IndexedDB cũ → giữ nguyên).
 *
 * Version history:
 * - v1 (legacy SKILL mẫu): baseline employees/rawLogs/timesheets/overtimes theo Plan.md §2.1
 * - v2: employees(dailyTimesheets...), rawAttendanceLogs, dailyTimesheets, overtimeRecords,
 *       leaveRequests, shiftRosters, ocrScans, settings — đã ship production
 * - v3: thêm accounts (username PK) cho local auth — đã ship production
 * - v4 (2026-08-28): CHUẨN HOÁ INDEX CHUYÊN NGHIỆP — thêm compound indexes cho mọi query
 *       nóng của Dashboard/Sidebar/Timesheet để tránh full scan khi scale >100k rows.
 *       Không đổi tên store, không xoá field, chỉ thêm index → không cần transform dữ liệu,
 *       upgrade callback giữ trống nhưng vẫn bump version để Dexie rebuild index an toàn.
 *       Đồng thời bổ sung helpers persistent storage + quota estimate theo SKILL §4bis.
 * - v5 (2026-08-28): THÊM 2 STORE CHUYÊN NGHIỆP — shiftClasses + rbacRoles theo SKILL ERD
 *       (Plan.md §3.2, §4.1 đã chốt field sau clarification của user 1.ok 2.ok 3.không cần auditLogs).
 *       Seed mặc định 4 ca + 6 roles từ DEFAULT_SETTINGS nếu store trống, không đè dữ liệu cũ.
 * - v6 (2026-08-28): SỬA LỖI BOOLEAN INDEX — 5 field boolean không phải key hợp lệ IndexedDB
 *       (spec chỉ cho Number/Date/String/Binary/Array) nên chuyển sang shadow Flag 0|1:
 *       isViolation → isViolationFlag, isRestViolation → isRestViolationFlag,
 *       active → activeFlag, isRotating → isRotatingFlag, isSystem → isSystemFlag.
 *       Giữ nguyên field boolean gốc cho UI/logic, chỉ đổi index sang Flag.
 *       Upgrade transform thật: modify mọi record cũ v2-v5 để Flag = boolean ? 1 : 0,
 *       không để index mới thiếu dữ liệu.
 * - v7 (2026-09-09): THÊM 2 STORE CHO MA TRẬN NĂNG SUẤT & CHẤT LƯỢNG — productionLines + productivityQualityRates
 *       Seed mặc định Line Rivet 1 và Line Rivet 2 nếu store trống, không đè dữ liệu cũ.
 */

export class HRSystemDatabase extends Dexie {
  employees!: Table<IEmployee, string>;
  rawAttendanceLogs!: Table<IRawAttendanceLog, number>;
  dailyTimesheets!: Table<IDailyTimesheetCell, string>;
  overtimeRecords!: Table<IOvertimeRecord, string>;
  leaveRequests!: Table<ILeaveRequest, string>;
  shiftRosters!: Table<IShiftRosterEntry, string>;
  ocrScans!: Table<IOCREntry, string>;
  settings!: Table<{ key: string; value: any }, string>;
  accounts!: Table<IAccount, string>;
  shiftClasses!: Table<IShiftClass, string>;
  rbacRoles!: Table<IRbacRole, string>;
  productionLines!: Table<IProductionLine, string>;
  productivityQualityRates!: Table<IProductivityQualityRate, string>;
  userAuditLogs!: Table<IUserAuditLog, string>;

  constructor() {
    super('HRSystem_LeggettPlatt_DB');

    // v2: baseline theo code đã ship — giữ nguyên để không gãy IndexedDB người dùng cũ
    this.version(2).stores({
      employees: 'employeeId, erpId, fullName, department, shiftClassId, contractType, status',
      rawAttendanceLogs: '++id, employeeId, date, [employeeId+date], departmentCode',
      dailyTimesheets: 'employeeId_date, employeeId, date, statusCode, month, year',
      overtimeRecords: 'employeeId_date, employeeId, date, verificationStatus, month, year',
      leaveRequests: 'id, employeeId, date, leaveType, status',
      shiftRosters: 'employeeId_date, employeeId, date, shiftCode',
      ocrScans: 'id, extractedEmployeeId, extractedDate, matchStatus, scanTimestamp',
      settings: 'key'
    });

    // v3: bảng tài khoản đăng nhập cục bộ (local auth) — đã ship
    this.version(3).stores({
      accounts: 'username, role'
    });

    // v4: CHUẨN HOÁ INDEX CHUYÊN NGHIỆP — tối ưu cho query nóng, không mất dữ liệu
    // Mỗi index mới gắn với 1 use-case thật (grep src/pages, src/components/layout):
    // - employees: lọc theo department/shift/contract/status + badge đếm
    // - dailyTimesheets: lọc theo month+year, employeeId+month+year, statusCode (LA/ED/MCO/MCI)
    // - overtimeRecords: verificationStatus (PENDING) + month+year
    // - leaveRequests: status PENDING + department + employeeId
    // - shiftRosters: isRestViolation (<12h) + department
    // - ocrScans: matchStatus + scanTimestamp
    // - accounts: active + [role+active] cho RBAC đếm
    this.version(4).stores({
      employees:
        'employeeId, erpId, fullName, department, shiftClassId, contractType, status, [department+status], [contractType+status], [shiftClassId+status], [department+contractType]',
      rawAttendanceLogs:
        '++id, employeeId, date, [employeeId+date], departmentCode, [departmentCode+date]',
      dailyTimesheets:
        'employeeId_date, employeeId, date, statusCode, isViolation, month, year, [month+year], [employeeId+month+year], [statusCode+month+year], [employeeId+date], [isViolation+month+year]',
      overtimeRecords:
        'employeeId_date, employeeId, date, verificationStatus, month, year, [month+year], [employeeId+month+year], [verificationStatus+month+year], [employeeId+verificationStatus]',
      leaveRequests:
        'id, employeeId, date, leaveType, status, department, [status+date], [employeeId+status], [department+status], [leaveType+status]',
      shiftRosters:
        'employeeId_date, employeeId, date, shiftCode, isRestViolation, department, [isRestViolation+date], [department+date], [shiftCode+date]',
      ocrScans:
        'id, extractedEmployeeId, extractedDate, matchStatus, scanTimestamp, [matchStatus+scanTimestamp]',
      settings: 'key',
      accounts: 'username, role, active, [role+active]'
    }).upgrade(async _tx => {
      // Không cần transform dữ liệu — chỉ rebuild index.
      // Giữ callback rỗng nhưng khai báo để Dexie biết đây là migration có chủ đích,
      // tránh auto-migration ngầm khi user mở DB cũ (v2/v3) lên v4.
    });

    // v5: THÊM 2 STORE CHUYÊN NGHIỆP — shiftClasses + rbacRoles (đã chốt sau clarification)
    // Seed mặc định nếu trống, không đè dữ liệu cũ — đảm bảo người dùng cũ không mất data.
    this.version(5).stores({
      shiftClasses: 'shiftClassId, startTime, endTime, standardWorkDays, isRotating, workDaysPattern',
      rbacRoles: 'roleId, roleName, *permissions, isSystem'
    }).upgrade(async tx => {
      const now = new Date().toISOString();
      // Seed shiftClasses nếu trống
      const scCount = await (tx as any).table('shiftClasses').count();
      if (scCount === 0) {
        await (tx as any).table('shiftClasses').bulkPut([
          {
            shiftClassId: 'OFFICE_M_F',
            labelVi: 'HC Văn phòng (T2-T6 | 23 công)',
            labelEn: 'Office Mon-Fri (23 WDs)',
            startTime: '07:30',
            endTime: '16:00',
            standardWorkDays: 23,
            workDaysPattern: 'MON_FRI',
            isRotating: false,
            description: 'Hành chính văn phòng Thứ 2-6, nghỉ T7-CN',
            color: '#3B82F6',
            createdAt: now
          },
          {
            shiftClassId: 'OFFICE_M_S',
            labelVi: 'HC Chung (T2-T7 | 27 công)',
            labelEn: 'Office Mon-Sat (27 WDs)',
            startTime: '07:30',
            endTime: '16:00',
            standardWorkDays: 27,
            workDaysPattern: 'MON_SAT',
            isRotating: false,
            description: 'Hành chính chung Thứ 2-7, nghỉ CN',
            color: '#64748B',
            createdAt: now
          },
          {
            shiftClassId: 'SHIFT_1',
            labelVi: 'Ca 1 (06:00 - 14:00)',
            labelEn: 'Shift 1 (06:00 - 14:00)',
            startTime: '06:00',
            endTime: '14:00',
            standardWorkDays: 27,
            workDaysPattern: 'ROTATING',
            isRotating: true,
            description: 'Xoay ca sáng, nghỉ CN',
            color: '#6366F1',
            createdAt: now
          },
          {
            shiftClassId: 'SHIFT_2',
            labelVi: 'Ca 2 (14:00 - 22:00)',
            labelEn: 'Shift 2 (14:00 - 22:00)',
            startTime: '14:00',
            endTime: '22:00',
            standardWorkDays: 27,
            workDaysPattern: 'ROTATING',
            isRotating: true,
            description: 'Xoay ca chiều, nghỉ CN',
            color: '#EC4899',
            createdAt: now
          }
        ]);
      }
      // Seed rbacRoles nếu trống — từ DEFAULT_SETTINGS.rolePermissions (6 roles built-in)
      const roleCount = await (tx as any).table('rbacRoles').count();
      if (roleCount === 0) {
        const perms = DEFAULT_SETTINGS.rolePermissions as Record<string, string[]>;
        const roles: any[] = Object.entries(perms).map(([roleId, permissions]) => ({
          roleId,
          roleName: roleId,
          description: roleId === 'AD System' ? 'Super Admin — toàn quyền hệ thống' : roleId === 'HR Manager' ? 'HR Manager — toàn quyền HR' : `${roleId} — quyền theo phòng ban`,
          permissions,
          departmentScope: roleId.includes('Warehouse') ? 'WH' : roleId.includes('Production') ? 'Production' : roleId.includes('QC') ? 'QC' : null,
          isSystem: true,
          createdAt: now
        }));
        await (tx as any).table('rbacRoles').bulkPut(roles);
      }
    });

    // v6: SỬA LỖI BOOLEAN INDEX — boolean không phải key hợp lệ IndexedDB (chỉ Number/Date/String/Binary/Array)
    // Chuyển 5 field boolean sang shadow Flag 0|1 để index: isViolation→isViolationFlag,
    // isRestViolation→isRestViolationFlag, active→activeFlag, isRotating→isRotatingFlag, isSystem→isSystemFlag.
    // Giữ nguyên field boolean gốc cho UI/logic, chỉ đổi index sang Flag.
    this.version(6).stores({
      dailyTimesheets:
        'employeeId_date, employeeId, date, statusCode, isViolationFlag, month, year, [month+year], [employeeId+month+year], [statusCode+month+year], [employeeId+date], [isViolationFlag+month+year]',
      shiftRosters:
        'employeeId_date, employeeId, date, shiftCode, isRestViolationFlag, department, [isRestViolationFlag+date], [department+date], [shiftCode+date]',
      accounts: 'username, role, activeFlag, [role+activeFlag]',
      shiftClasses: 'shiftClassId, startTime, endTime, standardWorkDays, isRotatingFlag, workDaysPattern',
      rbacRoles: 'roleId, roleName, *permissions, isSystemFlag'
    }).upgrade(async tx => {
      // Transform dữ liệu cũ v2-v5: mọi record thiếu Flag sẽ được set Flag = boolean ? 1 : 0
      await (tx as any).table('dailyTimesheets').toCollection().modify((rec: any) => {
        if (typeof rec.isViolationFlag === 'undefined') rec.isViolationFlag = rec.isViolation ? 1 : 0;
      });
      await (tx as any).table('shiftRosters').toCollection().modify((rec: any) => {
        if (typeof rec.isRestViolationFlag === 'undefined') rec.isRestViolationFlag = rec.isRestViolation ? 1 : 0;
      });
      await (tx as any).table('accounts').toCollection().modify((rec: any) => {
        if (typeof rec.activeFlag === 'undefined') rec.activeFlag = rec.active ? 1 : 0;
      });
      await (tx as any).table('shiftClasses').toCollection().modify((rec: any) => {
        if (typeof rec.isRotatingFlag === 'undefined') rec.isRotatingFlag = rec.isRotating ? 1 : 0;
      });
      await (tx as any).table('rbacRoles').toCollection().modify((rec: any) => {
        if (typeof rec.isSystemFlag === 'undefined') rec.isSystemFlag = rec.isSystem ? 1 : 0;
      });
    });

    // v7: THÊM 2 STORE MỚI cho ma trận Năng suất & Chất lượng
    // v7 (2026-09-09): THÊM 2 STORE CHO MA TRẬN NĂNG SUẤT & CHẤT LƯỢNG — productionLines + productivityQualityRates
    // Seed mặc định 'line_rivet_1' và 'line_rivet_2' nếu store trống, bảo đảm an toàn dữ liệu cũ.
    this.version(7).stores({
      productionLines: 'id, name',
      productivityQualityRates: 'lineId_date, lineId, date, month, year, [lineId+month+year], [lineId+date]'
    }).upgrade(async tx => {
      const now = new Date().toISOString();
      const plCount = await (tx as any).table('productionLines').count();
      if (plCount === 0) {
        await (tx as any).table('productionLines').bulkPut([
          {
            id: 'line_rivet_1',
            name: 'Line Rivet 1',
            description: 'Chuyền đinh tán số 1',
            createdAt: now
          },
          {
            id: 'line_rivet_2',
            name: 'Line Rivet 2',
            description: 'Chuyền đinh tán số 2',
            createdAt: now
          }
        ]);
      }
    });

    // v8 (2026-09-12): THÊM STORE NHẬT KÝ HOẠT ĐỘNG NGƯỜI DÙNG & GIAO DỊCH HỆ THỐNG — userAuditLogs
    this.version(8).stores({
      userAuditLogs: 'id, username, actionType, timestamp, [username+timestamp], [actionType+timestamp]'
    });

    // v9 (2026-09-18): THÊM INDEX ĐỐI SOÁT ĐI SAI GIỜ SẮP CA (SHIFT MISMATCH)
    this.version(9).stores({
      shiftRosters:
        'employeeId_date, employeeId, date, shiftCode, isRestViolationFlag, isShiftMismatchFlag, department, [isRestViolationFlag+date], [isShiftMismatchFlag+date], [department+date], [shiftCode+date]',
    }).upgrade(async tx => {
      await (tx as any).table('shiftRosters').toCollection().modify((rec: any) => {
        if (typeof rec.isShiftMismatchFlag === 'undefined') rec.isShiftMismatchFlag = rec.isShiftMismatch ? 1 : 0;
      });
    });

    // Hooks tự đồng bộ Flag khi tạo/cập nhật — đảm bảo không sót chỗ set tay (v6)
    this.dailyTimesheets.hook('creating', (_p: any, obj: any) => {
      if (typeof obj.isViolationFlag === 'undefined') obj.isViolationFlag = obj.isViolation ? 1 : 0;
    });
    this.dailyTimesheets.hook('updating', (mods: any) => {
      if ('isViolation' in mods && !('isViolationFlag' in mods)) mods.isViolationFlag = mods.isViolation ? 1 : 0;
    });
    this.shiftRosters.hook('creating', (_p: any, obj: any) => {
      if (typeof obj.isRestViolationFlag === 'undefined') obj.isRestViolationFlag = obj.isRestViolation ? 1 : 0;
      if (typeof obj.isShiftMismatchFlag === 'undefined') obj.isShiftMismatchFlag = obj.isShiftMismatch ? 1 : 0;
    });
    this.shiftRosters.hook('updating', (mods: any) => {
      if ('isRestViolation' in mods && !('isRestViolationFlag' in mods)) mods.isRestViolationFlag = mods.isRestViolation ? 1 : 0;
      if ('isShiftMismatch' in mods && !('isShiftMismatchFlag' in mods)) mods.isShiftMismatchFlag = mods.isShiftMismatch ? 1 : 0;
    });
    this.accounts.hook('creating', (_p: any, obj: any) => {
      if (typeof obj.activeFlag === 'undefined') obj.activeFlag = obj.active ? 1 : 0;
    });
    this.accounts.hook('updating', (mods: any) => {
      if ('active' in mods && !('activeFlag' in mods)) mods.activeFlag = mods.active ? 1 : 0;
    });
    this.shiftClasses.hook('creating', (_p: any, obj: any) => {
      if (typeof obj.isRotatingFlag === 'undefined') obj.isRotatingFlag = obj.isRotating ? 1 : 0;
    });
    this.shiftClasses.hook('updating', (mods: any) => {
      if ('isRotating' in mods && !('isRotatingFlag' in mods)) mods.isRotatingFlag = mods.isRotating ? 1 : 0;
    });
    this.rbacRoles.hook('creating', (_p: any, obj: any) => {
      if (typeof obj.isSystemFlag === 'undefined') obj.isSystemFlag = obj.isSystem ? 1 : 0;
    });
    this.rbacRoles.hook('updating', (mods: any) => {
      if ('isSystem' in mods && !('isSystemFlag' in mods)) mods.isSystemFlag = mods.isSystem ? 1 : 0;
    });

    // LAN realtime push (P0-1 revive, quyết user 2026-09-20: 2 chiều mọi role).
    // Chỉ 3 bảng đã chốt: employees (NV mới xuống dept) + shiftRosters (xếp ca
    // 2 chiều) + productivityQualityRates (NS/CL). Ghi tay → POST journal.
    // Bulk/file/seed + nạp từ máy khác bị chặn trong guard (không spam, không loop).
    const lanPushTables = ['employees', 'shiftRosters', 'productivityQualityRates'];
    for (const tableName of lanPushTables) {
      const dexieTable = (this as any)[tableName];
      dexieTable.hook('creating', (_p: any, obj: any) => {
        if (obj) emitLanPush({ table: tableName, action: 'put', record: { ...obj } });
      });
      dexieTable.hook('updating', (mods: any, _key: any, obj: any) => {
        if (obj) emitLanPush({ table: tableName, action: 'put', record: { ...obj, ...mods } });
      });
      dexieTable.hook('deleting', (_key: any, _obj: any) => {
        emitLanPush({ table: tableName, action: 'delete', key: _key });
      });
    }
  }
}

export const db = new HRSystemDatabase();

// ---------------------------------------------------------------------------
// Persistent Storage & Quota — SKILL §4bis (bắt buộc vì 100% offline)
// ---------------------------------------------------------------------------

/**
 * Xin quyền persistent storage để trình duyệt không tự xoá IndexedDB khi thiếu dung lượng.
 * Gọi 1 lần ở bootstrap (main.tsx / App.tsx) TRƯỚC khi mở Dexie.
 * @returns true nếu đã persistent hoặc vừa xin được, false nếu trình duyệt từ chối (cần cảnh báo backup)
 */
export async function ensurePersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    const already = await navigator.storage.persisted();
    if (already) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export interface StorageEstimate {
  usage?: number;
  quota?: number;
  percentUsed: number | null;
}

/**
 * Giám sát quota IndexedDB — cảnh báo trước khi import Excel >20k dòng.
 * Ngưỡng khuyến nghị: 80% cảnh báo, 95% chặn import mới.
 */
export async function getStorageEstimate(): Promise<StorageEstimate | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return {
      usage,
      quota,
      percentUsed: quota && usage ? (usage / quota) * 100 : null
    };
  } catch {
    return null;
  }
}

// Default initial settings
export const DEFAULT_SETTINGS: ISystemSettings = {
  overtimeRounding: 'exact',
  defaultAnnualLeaveQuota: 12,
  tradeUnionFee: 40000,
  diligenceDeductionRules: [
    {
      department: 'ALL',
      twoDaysULPenaltyPct: 50,
      threeDaysULPenaltyPct: 100
    }
  ],
  nightShiftAllowanceRate: 30,
  rolePermissions: {
    'HR Manager': ['ALL_ACCESS'],
    'HR Admin': ['VIEW_DASHBOARD', 'MANAGE_EMPLOYEES', 'IMPORT_LOGS', 'MANAGE_TIMESHEET', 'MANAGE_OT', 'MANAGE_LEAVE', 'MANAGE_ROSTER', 'SCAN_OCR', 'VIEW_PRODUCTIVITY_QUALITY', 'EDIT_PRODUCTIVITY_RATE', 'EDIT_QUALITY_RATE'],
    'Warehouse Admin': ['MANAGE_DEPT_ROSTER'],
    'Production Admin': ['MANAGE_DEPT_ROSTER', 'VIEW_PRODUCTIVITY_QUALITY', 'EDIT_PRODUCTIVITY_RATE'],
    'QC Admin': ['MANAGE_DEPT_ROSTER', 'VIEW_PRODUCTIVITY_QUALITY', 'EDIT_QUALITY_RATE'],
    'AD System': ['ALL_ACCESS', 'SYSTEM_SETTINGS', 'MANAGE_ROLES_PERMISSIONS', 'MANAGE_USERS', 'VIEW_PRODUCTIVITY_QUALITY', 'EDIT_PRODUCTIVITY_RATE', 'EDIT_QUALITY_RATE']
  },
  productivityBonusConfig: {
    defaultBaseRate: 1000000,
    formula: '(TotalWD + TotalAL) * BaseRate / StandardWD  →  (AO+AP)*BF/AN',
    formulaGroup2: '(TotalWD + TotalAL) * 1.000.000 / StandardWD',
    probationGetsBonusGroup2: false,
    deductULGroup2Rule: 'same_as_diligence',
    applyLineRatesToGroup2: true,
    useDepartmentOverride: false,
    departmentBaseRates: {}
  },
  diligenceBonusConfig: {
    baseAmount: 500000,
    countRange: 'J:AM',
    countOffAsUL: true,
    twoDaysULPenaltyPct: 50,
    threeDaysULPenaltyPct: 100
  }
};
