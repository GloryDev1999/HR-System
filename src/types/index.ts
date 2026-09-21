export type RoleType =
  | 'HR Manager'
  | 'HR Admin'
  | 'Warehouse Admin'
  | 'Production Admin'
  | 'QC Admin'
  | 'AD System';

/** Tài khoản đăng nhập cục bộ (hash SHA-256 + salt, lưu IndexedDB) */
export interface IAccount {
  username: string;          // khóa chính
  displayName: string;
  role: RoleType;
  departmentScope?: string | null; // 'WH', 'Production', 'QC', hoặc null (toàn công ty)
  salt: string;              // hex 16 bytes
  passwordHash: string;      // hex SHA-256(salt || password)
  active: boolean;           // giữ boolean gốc cho UI/logic
  activeFlag: 0 | 1;         // shadow 0|1 CHỈ để index — IndexedDB không cho boolean làm key
  createdAt: string;
  lastLoginAt?: string;
  failedLoginAttempts?: number; // Số lần đăng nhập sai liên tiếp
  isLocked?: boolean;           // Tài khoản bị khóa do nhập sai quá 10 lần
}

/** Phiên đăng nhập hiện hành */
export interface SessionUser {
  username: string;
  displayName: string;
  role: RoleType;
  departmentScope?: string | null;
}

export type LanguageType = 'vi' | 'en';

export type ShiftClassType = 
  | 'OFFICE_M_F'    // Hành chính văn phòng: Thứ 2 - Thứ 6 (7:30 - 16:00), công chuẩn 23
  | 'OFFICE_M_S'    // Hành chính chung: Thứ 2 - Thứ 7 (7:30 - 16:00), công chuẩn 27
  | 'SHIFT_1'       // Ca 1: 06:00 - 14:00 (xoay ca)
  | 'SHIFT_2';      // Ca 2: 14:00 - 22:00 (xoay ca)

export type ContractType = 
  | 'OFFICIAL'      // Chính thức: Chu kỳ công 21 -> 20 tháng sau
  | 'SEASONAL';     // Thời vụ: Chu kỳ công 1 -> 31 hàng tháng

export type EmployeeStatus = 'ACTIVE' | 'RESIGNED' | 'MATERNITY';

export interface ICustomAllowances {
  pcccAllowance: number;      // Phụ cấp PCCC (ví dụ 3 NV bảo trì)
  hazardousAllowance: number; // Phụ cấp độc hại (bộ phận chuyền sơn)
  diligenceBonus: number;     // Tiền chuyên cần (mặc định 500,000)
  productivityBonus: number;  // Thưởng năng suất
  tradeUnionFee: number;      // Trừ đoàn phí (mặc định -40,000 VND)
  otherFees: number;          // Chi phí khác
  extraBonus?: number;        // Thưởng thêm (hiển thị trên bảng chấm công)
}

export interface IAnnualLeaveBalance {
  initialQuota: number;       // Hạn mức phép năm ban đầu (linh hoạt, HR chỉnh sửa)
  usedDays: number;           // Số ngày đã dùng
  remainingDays: number;      // Số ngày còn lại
}

export interface IEmployee {
  employeeId: string;         // Khóa chính: LEP001, LEP010, ...
  erpId?: string;             // Mã ERP/Chấm công: 1013789
  fullName: string;           // Tên nhân viên
  department: string;         // Finance, Production, WH, Logistics, QC, EHS, Sales, IT
  position: string;           // Chức vụ
  startDate: string;          // DD/MM/YYYY
  contractType: ContractType;
  shiftClassId: ShiftClassType;
  customAllowances: ICustomAllowances;
  annualLeaveBalance: IAnnualLeaveBalance;
  status: EmployeeStatus;
  resignedDate?: string;
  notes?: string;
  maternityStartDate?: string; // YYYY-MM-DD
  maternityEndDate?: string;   // YYYY-MM-DD
  businessTripStartDate?: string; // YYYY-MM-DD - Chế độ công tác
  businessTripEndDate?: string;   // YYYY-MM-DD
  businessTripLocation?: string;  // Địa điểm / Lý do công tác
  businessTripNote?: string;
  // Mở rộng: hợp đồng & thử việc
  contractTerm?: '1_MONTH' | '2_MONTHS' | '1_YEAR' | '3_YEARS' | 'PERMANENT'; // thời hạn hợp đồng
  contractStartDate?: string; // DD/MM/YYYY
  contractEndDate?: string;   // DD/MM/YYYY
  probationMonths?: 1 | 2;    // thời gian thử việc
  probationEndDate?: string;  // DD/MM/YYYY - tự tính từ startDate + probationMonths
  // Phân loại Line sản xuất & Nhóm năng suất mới
  productionLine?: string;    // vd: 'Line Rivet 1', 'Line Rivet 2', v.v.
  productivityGroup?: 1 | 2;  // Nhóm năng suất 1 hoặc 2
}

export interface IRawAttendanceLog {
  id?: number;
  employeeId: string;
  fullName: string;
  departmentCode: string;     // Composite key LEP04046224
  date: string;               // YYYY-MM-DD
  dayOfWeek: string;          // Ba, Tư, Năm, Sáu, Bảy, CN, Hai
  checkIn: string;            // HH:mm
  checkOut: string;           // HH:mm
  lateMinutes: number;        // Phút đi trễ
  earlyMinutes: number;       // Phút về sớm
  workUnits: number;          // Công (0, 0.5, 1)
  totalHours: number;         // Tổng giờ
  overtimeHours: number;      // Giờ tăng ca
  totalOverall?: number;
  shiftName?: string;
}

export type AttendanceStatusCode = 
  | 'W'         // Đi làm đầy đủ
  | 'N'         // Đi ca đêm (Ca 2 14:00 - 22:00)
  | 'OFF'       // Vắng không quẹt thẻ ngày làm việc (Chờ bù phép)
  | 'Off'       // Vắng không quẹt thẻ (tương thích)
  | 'WO'        // Nghỉ hàng tuần (Weekly Off)
  | 'AL'        // Nghỉ phép năm
  | 'UL'        // Nghỉ không lương
  | 'SL'        // Nghỉ ốm / bệnh
  | 'PL'        // Nghỉ phép tang hoặc kết hôn (chế độ có lương)
  | 'PH'        // Nghỉ lễ
  | 'BT'        // Công tác
  | 'LA'        // Đi làm trễ (2p đến <60p)
  | 'ED'        // Về sớm (2p đến <60p)
  | 'MCO'       // Chỉ có giờ ra, không có giờ vào
  | 'MCI'       // Chỉ có giờ vào, không có giờ ra
  | 'W/2 AL/2'  // Nửa ngày làm, nửa ngày phép
  | 'W/2 UL/2'  // Nửa ngày làm, nửa ngày không lương
  | 'AL/2 UL/2' // Nửa ngày phép, nửa ngày không lương
  | 'ML'        // Nghỉ thai sản (Maternity Leave)
  | 'MATERNITY LEAVE' // Nghỉ thai sản (tương thích)
  | 'RESIGNED'  // Đã nghỉ việc
  | (string & {}); // Hỗ trợ định dạng phân giờ W6/AL2, W4/UL4, W7/PL1, v.v.

export interface IDailyTimesheetCell {
  employeeId_date: string;    // LEP010_2026-07-21
  employeeId: string;
  date: string;               // YYYY-MM-DD
  dayIndex: number;           // 1..31
  statusCode: AttendanceStatusCode;
  checkIn?: string;
  checkOut?: string;
  lateMinutes?: number;
  earlyMinutes?: number;
  isViolation?: boolean;      // giữ boolean gốc cho UI
  isViolationFlag?: 0 | 1;    // shadow 0|1 CHỈ để index
  violationNote?: string;
  calculatedOvertime: number;
  month: number;
  year: number;
}

export type OvertimeVerificationStatus = 'PENDING' | 'MATCHED' | 'MISMATCH';

export interface IOvertimeRecord {
  employeeId_date: string;    // LEP010_2026-07-21
  employeeId: string;
  date: string;               // YYYY-MM-DD
  dayOfWeek: string;
  hours: number;              // Số giờ tăng ca chuẩn (phút / 60)
  dayType: 'WEEKDAY' | 'SUNDAY' | 'HOLIDAY';
  verificationStatus: OvertimeVerificationStatus;
  ocrExtractedHours?: number;
  ocrConfidence?: number;
  mismatchReason?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  month: number;
  year: number;
  startTime?: string;         // Giờ bắt đầu tăng ca
  endTime?: string;           // Giờ kết thúc tăng ca
  rawMinutes?: number;        // Tổng số phút tăng ca thực tế
  isEarlyIn?: boolean;        // Cờ gắn cho trường hợp vào sớm 6:00 - 6:30
  note?: string;              // Ghi chú chi tiết tăng ca
}

export type LeaveType = 'AL' | 'UL' | 'SL' | 'PL' | 'BT' | 'MATERNITY' | 'UNAUTHORIZED';

export interface ILeaveRequest {
  id: string;                 // UUID / ID
  employeeId: string;
  fullName: string;
  department: string;
  date: string;               // YYYY-MM-DD
  leaveType: LeaveType;
  durationDays: number;       // 1 hoặc 0.5 hoặc tỷ lệ ngày tương ứng (missedHours / 8)
  missedHours?: number;       // Số giờ vắng mặt (1..8)
  workedHours?: number;       // Số giờ làm việc thực tế (0..7)
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reason?: string;
  rejectionReason?: string;
  processedBy?: string;
  processedAt?: string;
}

export interface IShiftRosterEntry {
  employeeId_date: string;    // LEP010_2026-07-21
  employeeId: string;
  fullName: string;
  department: string;
  date: string;               // YYYY-MM-DD
  shiftCode: ShiftClassType;
  startTime: string;          // 06:00, 14:00, 07:30
  endTime: string;            // 14:00, 22:00, 16:00
  previousShiftEndTime?: string; // Giờ kết thúc ca trước
  restHours?: number;         // Khoảng nghỉ giữa 2 ca
  isRestViolation: boolean;   // giữ boolean gốc
  isRestViolationFlag: 0 | 1; // shadow 0|1 CHỈ để index
  violationDetails?: string;
  actualShiftCode?: ShiftClassType | string;
  actualCheckIn?: string;
  actualCheckOut?: string;
  isShiftMismatch?: boolean;
  isShiftMismatchFlag?: 0 | 1;
  mismatchDetails?: string;
}

export interface IOCREntry {
  id: string;
  fileName: string;
  scanTimestamp: string;
  extractedEmployeeId?: string;
  extractedDate?: string;
  extractedHours?: number;
  rawText: string;
  confidence: number;
  matchStatus: 'MATCHED' | 'MISMATCH' | 'NOT_FOUND';
  details?: string;
}

export interface IShiftClass {
  shiftClassId: string;       // PK: OFFICE_M_F, OFFICE_M_S, SHIFT_1, SHIFT_2 hoặc custom SHIFT_3...
  labelVi: string;            // vd: Ca 1 (06:00 - 14:00)
  labelEn: string;            // vd: Shift 1 (06:00 - 14:00)
  startTime: string;          // HH:mm
  endTime: string;            // HH:mm
  standardWorkDays: number;   // 23 (MON_FRI) hoặc 27 (MON_SAT/ROTATING)
  workDaysPattern: 'MON_FRI' | 'MON_SAT' | 'ROTATING';
  isRotating: boolean;        // giữ boolean gốc
  isRotatingFlag: 0 | 1;      // shadow 0|1 CHỈ để index
  description?: string;
  color?: string;             // hex cho badge UI
  createdAt: string;          // ISO
  updatedAt?: string;
}

export interface IRbacRole {
  roleId: string;             // PK: HR Manager, HR Admin,... hoặc custom role
  roleName: string;           // Display name
  description?: string;
  permissions: string[];      // vd: ['VIEW_DASHBOARD', 'MANAGE_EMPLOYEES']
  departmentScope?: string | null; // null = toàn công ty, else 'Production'...
  isSystem: boolean;          // giữ boolean gốc
  isSystemFlag: 0 | 1;        // shadow 0|1 CHỈ để index
  createdAt: string;
  updatedAt?: string;
}

/** Chuyền/Line sản xuất (vd Line Rivet 1, Line Rivet 2...) */
export interface IProductionLine {
  id: string;                 // PK: line_rivet_1, line_rivet_2...
  name: string;               // Display name: 'Line Rivet 1', 'Line Rivet 2'
  description?: string;
  createdAt: string;          // ISO string
}

/** Bản ghi tỷ lệ Năng suất & Chất lượng theo ngày của từng Line */
export interface IProductivityQualityRate {
  lineId_date: string;        // PK composite: `${lineId}_${date}`, vd 'line_rivet_1_2026-08-01'
  lineId: string;             // FK -> productionLines.id
  date: string;               // YYYY-MM-DD
  productivityRate: number;   // Tỷ lệ % năng suất (0..150)
  qualityRate: number;        // Tỷ lệ % chất lượng (0..100)
  month: number;
  year: number;
  updatedAt?: string;
  updatedBy?: string;
}

export interface ISystemSettings {
  overtimeRounding: 'exact' | '15min' | '30min';
  defaultAnnualLeaveQuota: number;
  tradeUnionFee: number;      // Mức trích đoàn phí hàng tháng (mặc định 40000, cấu hình linh hoạt)
  diligenceDeductionRules: {
    department: string;       // 'ALL' hoặc tên phòng ban
    twoDaysULPenaltyPct: number;   // 50%
    threeDaysULPenaltyPct: number; // 100%
  }[];
  nightShiftAllowanceRate: number; // Tỷ lệ phụ cấp ca đêm
  rolePermissions: Record<RoleType, string[]>;
  // Công thức tiền năng suất — hệ thống hoá để custom ở Settings
  productivityBonusConfig: {
    defaultBaseRate: number;           // BF mặc định cho NV mới (vd 1.000.000)
    formula: string;                   // mô tả công thức, vd "(TotalWD+TotalAL)*BaseRate/StandardWD"
    formulaGroup2?: string;            // công thức Nhóm 2: "(TotalWD+TotalAL)*1.000.000/StandardWD"
    probationGetsBonusGroup2?: boolean; // false: thử việc không được nhận
    deductULGroup2Rule?: 'zero' | 'same_as_diligence'; // 'zero': nghỉ UL mất hẳn; 'same_as_diligence': nghỉ 2 ngày trừ 50%
    applyLineRatesToGroup2?: boolean;  // có nhân với tỷ lệ NS/CL của line không
    useDepartmentOverride: boolean;
    departmentBaseRates?: Record<string, number>; // override theo phòng ban nếu bật
  };
  // Công thức tiền chuyên cần — hệ thống hoá để custom ở Settings
  diligenceBonusConfig: {
    baseAmount: number;                // 500000 mặc định, custom được
    countRange: 'I:AM' | 'J:AM';       // phạm vi COUNTIF trong Excel (J:AM khớp file gốc, I:AM cho toàn kỳ)
    countOffAsUL: boolean;             // Off và UL được cộng dồn theo yêu cầu
    twoDaysULPenaltyPct?: number;      // 50%
    threeDaysULPenaltyPct?: number;    // 100%
  };
}

export type AuditActionType =
  | 'AUTH_LOGIN'
  | 'AUTH_LOGOUT'
  | 'ASSIGN_SHIFT'
  | 'UPDATE_RATE_NS'
  | 'UPDATE_RATE_CL'
  | 'APPROVE_LEAVE'
  | 'REJECT_LEAVE'
  | 'TIMESHEET_EDIT'
  | 'CREATE_USER'
  | 'RESET_PASSWORD'
  | 'UPDATE_USER_NAME'
  | 'TOGGLE_USER_ACTIVE'
  | 'UPDATE_USER_ROLE';

export interface IUserAuditLog {
  id: string;                 // UUID hoặc nanoId
  timestamp: string;          // ISO Date string
  username: string;           // kieu, hoa, vinh, nguyetanh, han, glory...
  displayName: string;        // Kieu(Mia), Vinh(Glory)...
  role: RoleType;
  actionType: AuditActionType;
  targetEntity: string;       // Đối tượng bị tác động (vd: 'WH - LEP010', 'line_rivet_1 (2026-08-01)', 'han')
  details: string;            // Diễn giải chi tiết
}
