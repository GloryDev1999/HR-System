import type { ISystemSettings } from '../types';

/**
 * DEFAULT_SETTINGS — fallback khi app_settings.systemSettings chưa có trên Supabase.
 * Copy 1-1 từ src/db/index.ts cũ (Dexie đã xóa). Seed thật nằm trong supabase/schema.sql.
 */
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
