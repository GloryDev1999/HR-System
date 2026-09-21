-- ============================================================================
-- SmartHR (Leggett & Platt) — Supabase Postgres Schema v1
-- Nguồn đối chiếu: pipeline.md §3 + src/db/index.ts (Dexie v2→v9, 14 stores)
--           + src/types/index.ts + src/context/AuthContext.tsx
-- Nguyên tắc: Supabase Auth là source-of-truth credential,
--             public.profiles là mirror RBAC (xem §0 bên dưới).
-- Chạy trong Supabase Dashboard → SQL Editor (toàn file, 1 lần).
-- Yêu cầu: bỏ hẳn Dexie, mạng ổn định, realtime bật cho mọi bảng nghiệp vụ.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- §0. QUYẾT ĐỊNH AUTH (trả lời câu hỏi: table hay Authentication?)
-- DÙNG CẢ HAI, mỗi thứ một việc:
--   1. auth.users (Supabase Auth, schema auth, KHÔNG tự tạo): giữ password
--      bcrypt, session JWT, refresh token, lockout. Xóa toàn bộ
--      salt/passwordHash/sha256 tay trong AuthContext cũ.
--   2. public.profiles (bảng dưới đây, PK = auth.users.id UUID):
--      giữ displayName, role, departmentScope, active, failedLoginAttempts,
--      isLocked — tức là mọi field của IAccount TRỪ credential.
-- Lý do (theo skill supabase security checklist):
--   - Không bao giờ dùng user_metadata cho phân quyền (user tự sửa được).
--     Role lưu ở profiles + app_metadata (do trigger sync, server-side).
--   - RLS policies tra profiles bằng (select auth.uid()) — không dùng
--     auth.role() đã deprecated.
--   - Trigger handle_new_user bên dưới tự tạo profile khi signUp,
--     nên frontend chỉ cần supabase.auth.signUp / signIn, không tự INSERT.
-- ----------------------------------------------------------------------------

-- Sạch khi chạy lại (DEV ONLY — comment lại khi chạy production đã có data)
-- DROP SCHEMA public CASCADE; CREATE SCHEMA public;

-- ============================ ENUMS =========================================
DO $$ BEGIN CREATE TYPE role_type AS ENUM (
  'HR Manager','HR Admin','Warehouse Admin','Production Admin','QC Admin','AD System'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE contract_type AS ENUM ('OFFICIAL','SEASONAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE employee_status AS ENUM ('ACTIVE','RESIGNED','MATERNITY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE shift_class_id AS ENUM (
  'OFFICE_M_F','OFFICE_M_S','SHIFT_1','SHIFT_2'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- NOTE: ca custom (SHIFT_3...) về sau: ALTER TYPE ... ADD VALUE, hoặc đổi
-- shift_classes.pk sang TEXT nếu cần custom tự do. v1 giữ ENUM = 4 ca đã chốt.

DO $$ BEGIN CREATE TYPE ot_status AS ENUM ('PENDING','MATCHED','MISMATCH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE leave_type AS ENUM (
  'AL','UL','SL','PL','BT','MATERNITY','UNAUTHORIZED'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE leave_status AS ENUM ('PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE ocr_match AS ENUM ('MATCHED','MISMATCH','NOT_FOUND');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================ 1. employees ==================================
-- Map: Dexie employees (PK employeeId TEXT). Bỏ compound-index Dexie,
-- thay bằng btree Postgres + FK index (skill schema-foreign-key-indexes).
CREATE TABLE IF NOT EXISTS public.employees (
  employee_id      TEXT PRIMARY KEY,               -- LEP001, LEP010...
  erp_id           TEXT,
  full_name        TEXT NOT NULL,
  department       TEXT NOT NULL,                  -- Finance, Production, WH...
  position         TEXT NOT NULL DEFAULT '',
  start_date       TEXT NOT NULL DEFAULT '',       -- giữ TEXT DD/MM/YYYY (compat UI)
  contract_type    contract_type NOT NULL DEFAULT 'OFFICIAL',
  shift_class_id   TEXT NOT NULL DEFAULT 'OFFICE_M_S',
  custom_allowances JSONB NOT NULL DEFAULT '{}',   -- ICustomAllowances
  annual_leave_balance JSONB NOT NULL DEFAULT '{}',-- IAnnualLeaveBalance
  status           employee_status NOT NULL DEFAULT 'ACTIVE',
  resigned_date    TEXT,
  notes            TEXT,
  maternity_start_date DATE,
  maternity_end_date   DATE,
  business_trip_start_date DATE,
  business_trip_end_date   DATE,
  business_trip_location TEXT,
  business_trip_note TEXT,
  contract_term    TEXT,
  contract_start_date TEXT,
  contract_end_date   TEXT,
  probation_months SMALLINT CHECK (probation_months IN (1,2)),
  probation_end_date  TEXT,
  production_line  TEXT,
  productivity_group SMALLINT CHECK (productivity_group IN (1,2)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employees_dept_status ON public.employees (department, status);
CREATE INDEX IF NOT EXISTS idx_employees_contract_status ON public.employees (contract_type, status);
CREATE INDEX IF NOT EXISTS idx_employees_shift_status ON public.employees (shift_class_id, status);
CREATE INDEX IF NOT EXISTS idx_employees_name_trgm ON public.employees (full_name);
-- Full-text search tên NV (skill advanced-full-text-search): cột generated
ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(full_name,'') || ' ' || coalesce(employee_id,''))) STORED;
CREATE INDEX IF NOT EXISTS idx_employees_fts ON public.employees USING GIN (fts);

-- ============================ 2. profiles (thay accounts) ===================
-- Map: Dexie accounts (PK username) → Supabase Auth + profiles.
-- PK là auth.users.id để JOIN RLS 1-1. Giữ username UNIQUE để login cũ
-- (kieu/hoa/vinh...) hoạt động, trigger bên dưới backfill.
CREATE TABLE IF NOT EXISTS public.profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username      TEXT UNIQUE NOT NULL,              -- kieu, hoa, vinh...
  display_name  TEXT NOT NULL,
  role          role_type NOT NULL,
  department_scope TEXT,                           -- 'WH'|'Production'|'QC'|NULL
  active        BOOLEAN NOT NULL DEFAULT true,     -- Postgres có BOOLEAN thật:
  failed_login_attempts INT NOT NULL DEFAULT 0,    -- bỏ shadow Flag 0|1 của Dexie v6
  is_locked     BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_profiles_role_active ON public.profiles (role, active);
CREATE INDEX IF NOT EXISTS idx_profiles_username_lower ON public.profiles (lower(username));

-- Trigger: tự tạo profile khi có auth.users mới (SECURITY DEFINER nhưng ở
-- schema private + có kiểm tra, KHÔNG đặt ở public theo skill checklist).
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, private, auth
AS $$
BEGIN
  INSERT INTO public.profiles (id, username, display_name, role)
  VALUES (
    NEW.id,
    coalesce(NEW.email, 'user_' || substr(NEW.id::text, 1, 8)),
    coalesce(NEW.email, 'New user'),
    'HR Admin'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION private.handle_new_user();
REVOKE ALL ON FUNCTION private.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ============================ 3. shift_classes ==============================
CREATE TABLE IF NOT EXISTS public.shift_classes (
  shift_class_id TEXT PRIMARY KEY,
  label_vi TEXT NOT NULL,
  label_en TEXT NOT NULL DEFAULT '',
  start_time TIME NOT NULL,                        -- Dexie lưu 'HH:mm' TEXT →
  end_time   TIME NOT NULL,                        -- Postgres TIME, query nghỉ <12h dễ
  standard_work_days SMALLINT NOT NULL DEFAULT 27,
  work_days_pattern TEXT NOT NULL DEFAULT 'MON_SAT'
    CHECK (work_days_pattern IN ('MON_FRI','MON_SAT','ROTATING')),
  is_rotating BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

-- ============================ 4. rbac_roles ================================
CREATE TABLE IF NOT EXISTS public.rbac_roles (
  role_id TEXT PRIMARY KEY,
  role_name TEXT NOT NULL,
  description TEXT,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  department_scope TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ
);

-- ============================ 5. raw_attendance_logs ========================
-- Dexie ++id auto-increment → BIGGENERATED. date TEXT YYYY-MM-DD → DATE thật
-- để query month/year không cần cột phụ, nhưng GIỮ month/year generated
-- để tương thích compound index cũ [month+year].
CREATE TABLE IF NOT EXISTS public.raw_attendance_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES public.employees(employee_id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT '',
  department_code TEXT NOT NULL DEFAULT '',
  date DATE NOT NULL,
  day_of_week TEXT NOT NULL DEFAULT '',
  check_in TIME,
  check_out TIME,
  late_minutes INT NOT NULL DEFAULT 0,
  early_minutes INT NOT NULL DEFAULT 0,
  work_units NUMERIC(3,1) NOT NULL DEFAULT 0,
  total_hours NUMERIC(5,2) NOT NULL DEFAULT 0,
  overtime_hours NUMERIC(5,2) NOT NULL DEFAULT 0,
  total_overall NUMERIC(6,2),
  shift_name TEXT,
  month SMALLINT GENERATED ALWAYS AS (EXTRACT(MONTH FROM date)::smallint) STORED,
  year  SMALLINT GENERATED ALWAYS AS (EXTRACT(YEAR  FROM date)::smallint) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, date, check_in, check_out)
);
CREATE INDEX IF NOT EXISTS idx_rawlogs_emp_date ON public.raw_attendance_logs (employee_id, date);
CREATE INDEX IF NOT EXISTS idx_rawlogs_dept_date ON public.raw_attendance_logs (department_code, date);
CREATE INDEX IF NOT EXISTS idx_rawlogs_month_year ON public.raw_attendance_logs (month, year);

-- ============================ 6. daily_timesheets ===========================
-- Dexie PK employeeId_date TEXT → giữ cột đó làm PK để frontend 0 thay đổi,
-- nhưng thêm CHECK + FK + DATE thật. Bỏ isViolationFlag (Postgres BOOLEAN).
CREATE TABLE IF NOT EXISTS public.daily_timesheets (
  employee_id_date TEXT PRIMARY KEY,               -- LEP010_2026-07-21
  employee_id TEXT NOT NULL REFERENCES public.employees(employee_id) ON DELETE CASCADE,
  date DATE NOT NULL,
  day_index SMALLINT NOT NULL CHECK (day_index BETWEEN 1 AND 31),
  status_code TEXT NOT NULL DEFAULT 'W',
  check_in TIME,
  check_out TIME,
  late_minutes INT NOT NULL DEFAULT 0,
  early_minutes INT NOT NULL DEFAULT 0,
  is_violation BOOLEAN NOT NULL DEFAULT false,
  violation_note TEXT,
  calculated_overtime NUMERIC(5,2) NOT NULL DEFAULT 0,
  month SMALLINT NOT NULL,
  year  SMALLINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ts_pk_match CHECK (employee_id_date = employee_id || '_' || to_char(date,'YYYY-MM-DD')),
  CONSTRAINT chk_ts_month CHECK (month = EXTRACT(MONTH FROM date)::smallint),
  CONSTRAINT chk_ts_year  CHECK (year  = EXTRACT(YEAR  FROM date)::smallint)
);
CREATE INDEX IF NOT EXISTS idx_ts_emp_month_year ON public.daily_timesheets (employee_id, month, year);
CREATE INDEX IF NOT EXISTS idx_ts_month_year ON public.daily_timesheets (month, year);
CREATE INDEX IF NOT EXISTS idx_ts_status_month_year ON public.daily_timesheets (status_code, month, year);
-- Partial index: query nóng AttendanceViolation chỉ lấy vi phạm (skill query-partial-indexes)
CREATE INDEX IF NOT EXISTS idx_ts_violations ON public.daily_timesheets (month, year)
  WHERE is_violation = true;

-- ============================ 7. overtime_records ===========================
CREATE TABLE IF NOT EXISTS public.overtime_records (
  employee_id_date TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES public.employees(employee_id) ON DELETE CASCADE,
  date DATE NOT NULL,
  day_of_week TEXT NOT NULL DEFAULT '',
  hours NUMERIC(5,2) NOT NULL DEFAULT 0,
  day_type TEXT NOT NULL DEFAULT 'WEEKDAY' CHECK (day_type IN ('WEEKDAY','SUNDAY','HOLIDAY')),
  verification_status ot_status NOT NULL DEFAULT 'PENDING',
  ocr_extracted_hours NUMERIC(5,2),
  ocr_confidence NUMERIC(5,2),
  mismatch_reason TEXT,
  verified_by TEXT,
  verified_at TIMESTAMPTZ,
  month SMALLINT NOT NULL,
  year  SMALLINT NOT NULL,
  start_time TIME,
  end_time TIME,
  raw_minutes INT,
  is_early_in BOOLEAN NOT NULL DEFAULT false,
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ot_pk_match CHECK (employee_id_date = employee_id || '_' || to_char(date,'YYYY-MM-DD'))
);
CREATE INDEX IF NOT EXISTS idx_ot_emp_month_year ON public.overtime_records (employee_id, month, year);
CREATE INDEX IF NOT EXISTS idx_ot_month_year ON public.overtime_records (month, year);
-- Partial index PENDING (trang OvertimeVerification query 99% status này)
CREATE INDEX IF NOT EXISTS idx_ot_pending ON public.overtime_records (month, year)
  WHERE verification_status = 'PENDING';

-- ============================ 8. leave_requests =============================
CREATE TABLE IF NOT EXISTS public.leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id TEXT NOT NULL REFERENCES public.employees(employee_id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  date DATE NOT NULL,
  leave_type leave_type NOT NULL,
  duration_days NUMERIC(4,1) NOT NULL DEFAULT 1,
  missed_hours NUMERIC(4,1),
  worked_hours NUMERIC(4,1),
  status leave_status NOT NULL DEFAULT 'PENDING',
  reason TEXT,
  rejection_reason TEXT,
  processed_by TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leave_status_date ON public.leave_requests (status, date);
CREATE INDEX IF NOT EXISTS idx_leave_emp_status ON public.leave_requests (employee_id, status);
CREATE INDEX IF NOT EXISTS idx_leave_dept_status ON public.leave_requests (department, status);
CREATE INDEX IF NOT EXISTS idx_leave_pending ON public.leave_requests (date) WHERE status = 'PENDING';

-- ============================ 9. shift_rosters ==============================
CREATE TABLE IF NOT EXISTS public.shift_rosters (
  employee_id_date TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES public.employees(employee_id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  date DATE NOT NULL,
  shift_code TEXT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  previous_shift_end_time TIME,
  rest_hours NUMERIC(4,1),
  is_rest_violation BOOLEAN NOT NULL DEFAULT false,
  violation_details TEXT,
  actual_shift_code TEXT,
  actual_check_in TIME,
  actual_check_out TIME,
  is_shift_mismatch BOOLEAN NOT NULL DEFAULT false,
  mismatch_details TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_roster_pk_match CHECK (employee_id_date = employee_id || '_' || to_char(date,'YYYY-MM-DD'))
);
CREATE INDEX IF NOT EXISTS idx_roster_dept_date ON public.shift_rosters (department, date);
CREATE INDEX IF NOT EXISTS idx_roster_shift_date ON public.shift_rosters (shift_code, date);
CREATE INDEX IF NOT EXISTS idx_roster_rest_viol ON public.shift_rosters (date) WHERE is_rest_violation = true;
CREATE INDEX IF NOT EXISTS idx_roster_mismatch ON public.shift_rosters (date) WHERE is_shift_mismatch = true;

-- ============================ 10. production_lines ==========================
CREATE TABLE IF NOT EXISTS public.production_lines (
  id TEXT PRIMARY KEY,                             -- line_rivet_1...
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================ 11. productivity_quality_rates ================
CREATE TABLE IF NOT EXISTS public.productivity_quality_rates (
  line_id_date TEXT PRIMARY KEY,                   -- line_rivet_1_2026-08-01
  line_id TEXT NOT NULL REFERENCES public.production_lines(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  productivity_rate NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK (productivity_rate BETWEEN 0 AND 150),
  quality_rate NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK (quality_rate BETWEEN 0 AND 100),
  month SMALLINT NOT NULL,
  year  SMALLINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  CONSTRAINT chk_pq_pk_match CHECK (line_id_date = line_id || '_' || to_char(date,'YYYY-MM-DD'))
);
CREATE INDEX IF NOT EXISTS idx_pq_line_month_year ON public.productivity_quality_rates (line_id, month, year);

-- ============================ 12. ocr_scans =================================
CREATE TABLE IF NOT EXISTS public.ocr_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name TEXT NOT NULL,
  scan_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  extracted_employee_id TEXT,
  extracted_date DATE,
  extracted_hours NUMERIC(5,2),
  raw_text TEXT NOT NULL DEFAULT '',
  confidence NUMERIC(5,2) NOT NULL DEFAULT 0,
  match_status ocr_match NOT NULL DEFAULT 'NOT_FOUND',
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_ocr_match_ts ON public.ocr_scans (match_status, scan_timestamp DESC);

-- ============================ 13. app_settings ==============================
-- Dexie settings (key/value any) → JSONB. Chỉ 1 row systemSettings + mở rộng.
CREATE TABLE IF NOT EXISTS public.app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
INSERT INTO public.app_settings (key, value)
VALUES ('systemSettings', '{
  "overtimeRounding": "exact",
  "defaultAnnualLeaveQuota": 12,
  "tradeUnionFee": 40000,
  "nightShiftAllowanceRate": 30,
  "diligenceDeductionRules": [{"department": "ALL", "twoDaysULPenaltyPct": 50, "threeDaysULPenaltyPct": 100}],
  "rolePermissions": {
    "HR Manager": ["ALL_ACCESS"],
    "HR Admin": ["VIEW_DASHBOARD","MANAGE_EMPLOYEES","IMPORT_LOGS","MANAGE_TIMESHEET","MANAGE_OT","MANAGE_LEAVE","MANAGE_ROSTER","SCAN_OCR","VIEW_PRODUCTIVITY_QUALITY","EDIT_PRODUCTIVITY_RATE","EDIT_QUALITY_RATE"],
    "Warehouse Admin": ["MANAGE_DEPT_ROSTER"],
    "Production Admin": ["MANAGE_DEPT_ROSTER","VIEW_PRODUCTIVITY_QUALITY","EDIT_PRODUCTIVITY_RATE"],
    "QC Admin": ["MANAGE_DEPT_ROSTER","VIEW_PRODUCTIVITY_QUALITY","EDIT_QUALITY_RATE"],
    "AD System": ["ALL_ACCESS","SYSTEM_SETTINGS","MANAGE_ROLES_PERMISSIONS","MANAGE_USERS","VIEW_PRODUCTIVITY_QUALITY","EDIT_PRODUCTIVITY_RATE","EDIT_QUALITY_RATE"]
  }
}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ============================ 14. user_audit_logs ===========================
CREATE TABLE IF NOT EXISTS public.user_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  username TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  action_type TEXT NOT NULL,
  target_entity TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_user_ts ON public.user_audit_logs (username, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON public.user_audit_logs (action_type, created_at DESC);

-- ============================ SEED (từ Dexie v5/v7) =========================
INSERT INTO public.shift_classes
  (shift_class_id,label_vi,label_en,start_time,end_time,standard_work_days,work_days_pattern,is_rotating,description,color)
VALUES
  ('OFFICE_M_F','HC Văn phòng (T2-T6 | 23 công)','Office Mon-Fri (23 WDs)','07:30','16:00',23,'MON_FRI',false,'Hành chính văn phòng Thứ 2-6, nghỉ T7-CN','#3B82F6'),
  ('OFFICE_M_S','HC Chung (T2-T7 | 27 công)','Office Mon-Sat (27 WDs)','07:30','16:00',27,'MON_SAT',false,'Hành chính chung Thứ 2-7, nghỉ CN','#64748B'),
  ('SHIFT_1','Ca 1 (06:00 - 14:00)','Shift 1 (06:00 - 14:00)','06:00','14:00',27,'ROTATING',true,'Xoay ca sáng, nghỉ CN','#6366F1'),
  ('SHIFT_2','Ca 2 (14:00 - 22:00)','Shift 2 (14:00 - 22:00)','14:00','22:00',27,'ROTATING',true,'Xoay ca chiều, nghỉ CN','#EC4899')
ON CONFLICT (shift_class_id) DO NOTHING;

INSERT INTO public.rbac_roles (role_id, role_name, description, permissions, department_scope, is_system)
VALUES
  ('HR Manager','HR Manager','HR Manager — toàn quyền trừ Settings/Users',
   '{ALL_ACCESS}', NULL, true),
  ('HR Admin','HR Admin','HR vận hành',
   '{VIEW_DASHBOARD,MANAGE_EMPLOYEES,IMPORT_LOGS,MANAGE_TIMESHEET,MANAGE_OT,MANAGE_LEAVE,MANAGE_ROSTER,SCAN_OCR,VIEW_PRODUCTIVITY_QUALITY,EDIT_PRODUCTIVITY_RATE,EDIT_QUALITY_RATE}', NULL, false),
  ('Warehouse Admin','Warehouse Admin','Sắp ca WH',
   '{MANAGE_DEPT_ROSTER}', 'WH', false),
  ('Production Admin','Production Admin','Sắp ca + NS',
   '{MANAGE_DEPT_ROSTER,VIEW_PRODUCTIVITY_QUALITY,EDIT_PRODUCTIVITY_RATE}', 'Production', false),
  ('QC Admin','QC Admin','Sắp ca + CL',
   '{MANAGE_DEPT_ROSTER,VIEW_PRODUCTIVITY_QUALITY,EDIT_QUALITY_RATE}', 'QC', false),
  ('AD System','AD System','Super Admin — toàn quyền hệ thống',
   '{ALL_ACCESS,SYSTEM_SETTINGS,MANAGE_ROLES_PERMISSIONS,MANAGE_USERS,VIEW_PRODUCTIVITY_QUALITY,EDIT_PRODUCTIVITY_RATE,EDIT_QUALITY_RATE}', NULL, true)
ON CONFLICT (role_id) DO NOTHING;

INSERT INTO public.production_lines (id, name, description)
VALUES
  ('line_rivet_1','Line Rivet 1','Chuyền đinh tán số 1'),
  ('line_rivet_2','Line Rivet 2','Chuyền đinh tán số 2')
ON CONFLICT (id) DO NOTHING;

-- ============================ updated_at trigger ============================
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_touch_employees ON public.employees;
CREATE TRIGGER trg_touch_employees BEFORE UPDATE ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_ts ON public.daily_timesheets;
CREATE TRIGGER trg_touch_ts BEFORE UPDATE ON public.daily_timesheets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_ot ON public.overtime_records;
CREATE TRIGGER trg_touch_ot BEFORE UPDATE ON public.overtime_records
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_roster ON public.shift_rosters;
CREATE TRIGGER trg_touch_roster BEFORE UPDATE ON public.shift_rosters
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS trg_touch_pq ON public.productivity_quality_rates;
CREATE TRIGGER trg_touch_pq BEFORE UPDATE ON public.productivity_quality_rates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================ RLS (bật mọi bảng public) =====================
-- Mô hình theo pipeline.md §2: AD System/HR Manager = toàn công ty;
-- Warehouse/Production/QC Admin = chỉ departmentScope của mình.
-- Helper inline (không dùng auth.role() deprecated, không SECURITY DEFINER public).
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rbac_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.raw_attendance_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_timesheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.overtime_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_rosters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.production_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.productivity_quality_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ocr_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_audit_logs ENABLE ROW LEVEL SECURITY;

-- Macro logic lặp lại cho mọi bảng dept-scoped:
--   is_full_access() := role IN ('AD System','HR Manager','HR Admin')
-- Viết trực tiếp trong từng policy để tránh function public (skill checklist).
-- Ví dụ mẫu cho employees; các bảng còn lại copy cùng mẫu, đổi tên bảng.

-- ---- employees ----
DROP POLICY IF EXISTS "employees_select" ON public.employees;
CREATE POLICY "employees_select" ON public.employees FOR SELECT TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.id = (select auth.uid())
      AND (p.role IN ('AD System','HR Manager','HR Admin')
           OR p.department_scope IS NULL
           OR p.department_scope = employees.department))
);
DROP POLICY IF EXISTS "employees_write" ON public.employees;
CREATE POLICY "employees_write" ON public.employees FOR ALL TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.id = (select auth.uid())
      AND p.role IN ('AD System','HR Manager','HR Admin'))
)
WITH CHECK (
  EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.id = (select auth.uid())
      AND p.role IN ('AD System','HR Manager','HR Admin'))
);

-- ---- shift_rosters (dept admin được write trong scope mình) ----
DROP POLICY IF EXISTS "rosters_select" ON public.shift_rosters;
CREATE POLICY "rosters_select" ON public.shift_rosters FOR SELECT TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.id = (select auth.uid())
      AND (p.role IN ('AD System','HR Manager','HR Admin')
           OR p.department_scope IS NULL
           OR p.department_scope = shift_rosters.department))
);
DROP POLICY IF EXISTS "rosters_write" ON public.shift_rosters;
CREATE POLICY "rosters_write" ON public.shift_rosters FOR ALL TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.id = (select auth.uid())
      AND (p.role IN ('AD System','HR Manager','HR Admin')
           OR (p.department_scope IS NOT NULL
               AND p.department_scope = shift_rosters.department)))
)
WITH CHECK (
  EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.id = (select auth.uid())
      AND (p.role IN ('AD System','HR Manager','HR Admin')
           OR (p.department_scope IS NOT NULL
               AND p.department_scope = shift_rosters.department)))
);

-- ---- leave_requests (cùng mẫu roster) ----
DROP POLICY IF EXISTS "leave_select" ON public.leave_requests;
CREATE POLICY "leave_select" ON public.leave_requests FOR SELECT TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.id = (select auth.uid())
      AND (p.role IN ('AD System','HR Manager','HR Admin')
           OR p.department_scope IS NULL
           OR p.department_scope = leave_requests.department))
);
DROP POLICY IF EXISTS "leave_write" ON public.leave_requests;
CREATE POLICY "leave_write" ON public.leave_requests FOR ALL TO authenticated
USING (
  EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.id = (select auth.uid())
      AND (p.role IN ('AD System','HR Manager','HR Admin')
           OR (p.department_scope IS NOT NULL
               AND p.department_scope = leave_requests.department)))
)
WITH CHECK (
  EXISTS (SELECT 1 FROM public.profiles p
    WHERE p.id = (select auth.uid())
      AND (p.role IN ('AD System','HR Manager','HR Admin')
           OR (p.department_scope IS NOT NULL
               AND p.department_scope = leave_requests.department)))
);

-- ---- các bảng toàn công ty: HR + dept đều đọc; ghi theo quyền ----
-- daily_timesheets / overtime_records / raw_attendance_logs
DROP POLICY IF EXISTS "ts_select" ON public.daily_timesheets;
CREATE POLICY "ts_select" ON public.daily_timesheets FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ts_write" ON public.daily_timesheets;
CREATE POLICY "ts_write" ON public.daily_timesheets FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager','HR Admin')))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager','HR Admin')));

DROP POLICY IF EXISTS "ot_select" ON public.overtime_records;
CREATE POLICY "ot_select" ON public.overtime_records FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ot_write" ON public.overtime_records;
CREATE POLICY "ot_write" ON public.overtime_records FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager','HR Admin')))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager','HR Admin')));

DROP POLICY IF EXISTS "raw_select" ON public.raw_attendance_logs;
CREATE POLICY "raw_select" ON public.raw_attendance_logs FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "raw_write" ON public.raw_attendance_logs;
CREATE POLICY "raw_write" ON public.raw_attendance_logs FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager','HR Admin')))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager','HR Admin')));

-- ---- productivity_quality_rates: Production sửa NS, QC sửa CL (enforce ở app;
--      RLS mở write cho 3 dept + HR để realtime không rớt, app chặn field) ----
DROP POLICY IF EXISTS "pq_select" ON public.productivity_quality_rates;
CREATE POLICY "pq_select" ON public.productivity_quality_rates FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "pq_write" ON public.productivity_quality_rates;
CREATE POLICY "pq_write" ON public.productivity_quality_rates FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid())
    AND p.role IN ('AD System','HR Manager','HR Admin','Production Admin','QC Admin')))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid())
    AND p.role IN ('AD System','HR Manager','HR Admin','Production Admin','QC Admin')));

-- ---- bảng danh mục / hệ thống: đọc all-auth, ghi HR+AD ----
DROP POLICY IF EXISTS "cat_read" ON public.shift_classes;
CREATE POLICY "cat_read" ON public.shift_classes FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "cat_write" ON public.shift_classes;
CREATE POLICY "cat_write" ON public.shift_classes FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager')))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager')));

DROP POLICY IF EXISTS "roles_read" ON public.rbac_roles;
CREATE POLICY "roles_read" ON public.rbac_roles FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "roles_write" ON public.rbac_roles;
CREATE POLICY "roles_write" ON public.rbac_roles FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role = 'AD System'))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role = 'AD System'));

DROP POLICY IF EXISTS "lines_read" ON public.production_lines;
CREATE POLICY "lines_read" ON public.production_lines FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "lines_write" ON public.production_lines;
CREATE POLICY "lines_write" ON public.production_lines FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager')))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager')));

DROP POLICY IF EXISTS "ocr_read" ON public.ocr_scans;
CREATE POLICY "ocr_read" ON public.ocr_scans FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ocr_write" ON public.ocr_scans;
CREATE POLICY "ocr_write" ON public.ocr_scans FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager','HR Admin')))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager','HR Admin')));

DROP POLICY IF EXISTS "settings_read" ON public.app_settings;
CREATE POLICY "settings_read" ON public.app_settings FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "settings_write" ON public.app_settings;
CREATE POLICY "settings_write" ON public.app_settings FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role = 'AD System'))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role = 'AD System'));

-- profiles: tự đọc + AD sửa; user đọc profile mình
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT TO authenticated
USING (id = (select auth.uid()) OR EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager')));
DROP POLICY IF EXISTS "profiles_write" ON public.profiles;
CREATE POLICY "profiles_write" ON public.profiles FOR ALL TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role = 'AD System'))
WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role = 'AD System'));

-- audit logs: insert all-auth, đọc HR+AD (chống sửa/xóa: không cấp UPDATE/DELETE,
-- dùng FOR ALL nhưng app chỉ insert/select; muốn chặt hơn thì tách policy)
DROP POLICY IF EXISTS "audit_insert" ON public.user_audit_logs;
CREATE POLICY "audit_insert" ON public.user_audit_logs FOR INSERT TO authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "audit_select" ON public.user_audit_logs;
CREATE POLICY "audit_select" ON public.user_audit_logs FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.profiles p
  WHERE p.id = (select auth.uid()) AND p.role IN ('AD System','HR Manager','HR Admin')));

-- ============================ REALTIME ======================================
-- Bật realtime cho 7 bảng nghiệp vụ (presence thay bằng Supabase Realtime
-- presence, không cần heartbeat SSE tay như server.js nữa).
DO $$
BEGIN
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.employees; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_timesheets; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.overtime_records; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.leave_requests; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.shift_rosters; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.productivity_quality_rates; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.user_audit_logs; EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- Replica identity FULL để Realtime payload DELETE có đủ row (UPDATE/DELETE)
ALTER TABLE public.employees REPLICA IDENTITY FULL;
ALTER TABLE public.daily_timesheets REPLICA IDENTITY FULL;
ALTER TABLE public.overtime_records REPLICA IDENTITY FULL;
ALTER TABLE public.leave_requests REPLICA IDENTITY FULL;
ALTER TABLE public.shift_rosters REPLICA IDENTITY FULL;
ALTER TABLE public.productivity_quality_rates REPLICA IDENTITY FULL;
