-- ============================================================================
-- SmartHR — Migration: bỏ public.profiles, roles vào Auth app_metadata
-- Chạy 1 LẦN trong SQL Editor (sau khi 6 users @leggett.com đã tạo xong).
--
-- Mô hình mới (chuẩn Supabase, không table trung gian):
--   auth.users.raw_app_meta_data = {username, display_name, role, department_scope}
--   RLS đọc trực tiếp JWT: (auth.jwt() -> 'app_metadata' ->> 'role')
--   - app_metadata chỉ service_role/Dashboard sửa được → an toàn cho RLS
--     (user_metadata thì user tự sửa được nên KHÔNG dùng cho phân quyền).
-- User mới về sau: Dashboard Authentication → Add user → Edit user →
--   sửa User Metadata? KHÔNG — sửa App Metadata (raw_app_meta_data).
-- ============================================================================

-- 1. Gỡ trigger + function tạo profiles tự động
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS private.handle_new_user();

-- 2. Xóa policies cũ trỏ public.profiles (liệt kê đủ để không sót)
DROP POLICY IF EXISTS "employees_select" ON public.employees;
DROP POLICY IF EXISTS "employees_write" ON public.employees;
DROP POLICY IF EXISTS "rosters_select" ON public.shift_rosters;
DROP POLICY IF EXISTS "rosters_write" ON public.shift_rosters;
DROP POLICY IF EXISTS "leave_select" ON public.leave_requests;
DROP POLICY IF EXISTS "leave_write" ON public.leave_requests;
DROP POLICY IF EXISTS "ts_select" ON public.daily_timesheets;
DROP POLICY IF EXISTS "ts_write" ON public.daily_timesheets;
DROP POLICY IF EXISTS "ot_select" ON public.overtime_records;
DROP POLICY IF EXISTS "ot_write" ON public.overtime_records;
DROP POLICY IF EXISTS "raw_select" ON public.raw_attendance_logs;
DROP POLICY IF EXISTS "raw_write" ON public.raw_attendance_logs;
DROP POLICY IF EXISTS "pq_select" ON public.productivity_quality_rates;
DROP POLICY IF EXISTS "pq_write" ON public.productivity_quality_rates;
DROP POLICY IF EXISTS "cat_read" ON public.shift_classes;
DROP POLICY IF EXISTS "cat_write" ON public.shift_classes;
DROP POLICY IF EXISTS "roles_read" ON public.rbac_roles;
DROP POLICY IF EXISTS "roles_write" ON public.rbac_roles;
DROP POLICY IF EXISTS "lines_read" ON public.production_lines;
DROP POLICY IF EXISTS "lines_write" ON public.production_lines;
DROP POLICY IF EXISTS "ocr_read" ON public.ocr_scans;
DROP POLICY IF EXISTS "ocr_write" ON public.ocr_scans;
DROP POLICY IF EXISTS "settings_read" ON public.app_settings;
DROP POLICY IF EXISTS "settings_write" ON public.app_settings;
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
DROP POLICY IF EXISTS "profiles_write" ON public.profiles;
DROP POLICY IF EXISTS "audit_insert" ON public.user_audit_logs;
DROP POLICY IF EXISTS "audit_select" ON public.user_audit_logs;

-- 3. Xóa bảng profiles (hết giá trị sau khi roles vào app_metadata)
DROP TABLE IF EXISTS public.profiles;

-- ============================================================================
-- 4. Policies mới đọc role/scope từ JWT app_metadata.
-- Quy ước: role IN ('AD System','HR Manager','HR Admin') = toàn quyền đọc
-- theo scope; dept admin (scope = WH/Production/QC) chỉ thấy phòng mình.
-- ============================================================================

-- ---- employees ----
CREATE POLICY "employees_select" ON public.employees FOR SELECT TO authenticated
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin')
  OR (auth.jwt() -> 'app_metadata' ->> 'department_scope') IS NULL
  OR (auth.jwt() -> 'app_metadata' ->> 'department_scope') = employees.department
);
CREATE POLICY "employees_write" ON public.employees FOR ALL TO authenticated
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin')
)
WITH CHECK (
  (auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin')
);

-- ---- shift_rosters (dept admin được write trong scope mình) ----
CREATE POLICY "rosters_select" ON public.shift_rosters FOR SELECT TO authenticated
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin')
  OR (auth.jwt() -> 'app_metadata' ->> 'department_scope') IS NULL
  OR (auth.jwt() -> 'app_metadata' ->> 'department_scope') = shift_rosters.department
);
CREATE POLICY "rosters_write" ON public.shift_rosters FOR ALL TO authenticated
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin')
  OR ((auth.jwt() -> 'app_metadata' ->> 'department_scope') IS NOT NULL
      AND (auth.jwt() -> 'app_metadata' ->> 'department_scope') = shift_rosters.department)
)
WITH CHECK (
  (auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin')
  OR ((auth.jwt() -> 'app_metadata' ->> 'department_scope') IS NOT NULL
      AND (auth.jwt() -> 'app_metadata' ->> 'department_scope') = shift_rosters.department)
);

-- ---- leave_requests (cùng mẫu roster) ----
CREATE POLICY "leave_select" ON public.leave_requests FOR SELECT TO authenticated
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin')
  OR (auth.jwt() -> 'app_metadata' ->> 'department_scope') IS NULL
  OR (auth.jwt() -> 'app_metadata' ->> 'department_scope') = leave_requests.department
);
CREATE POLICY "leave_write" ON public.leave_requests FOR ALL TO authenticated
USING (
  (auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin')
  OR ((auth.jwt() -> 'app_metadata' ->> 'department_scope') IS NOT NULL
      AND (auth.jwt() -> 'app_metadata' ->> 'department_scope') = leave_requests.department)
)
WITH CHECK (
  (auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin')
  OR ((auth.jwt() -> 'app_metadata' ->> 'department_scope') IS NOT NULL
      AND (auth.jwt() -> 'app_metadata' ->> 'department_scope') = leave_requests.department)
);

-- ---- daily_timesheets / overtime_records / raw_attendance_logs ----
CREATE POLICY "ts_select" ON public.daily_timesheets FOR SELECT TO authenticated USING (true);
CREATE POLICY "ts_write" ON public.daily_timesheets FOR ALL TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin'))
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin'));

CREATE POLICY "ot_select" ON public.overtime_records FOR SELECT TO authenticated USING (true);
CREATE POLICY "ot_write" ON public.overtime_records FOR ALL TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin'))
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin'));

CREATE POLICY "raw_select" ON public.raw_attendance_logs FOR SELECT TO authenticated USING (true);
CREATE POLICY "raw_write" ON public.raw_attendance_logs FOR ALL TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin'))
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin'));

-- ---- productivity_quality_rates: Production sửa NS, QC sửa CL ----
CREATE POLICY "pq_select" ON public.productivity_quality_rates FOR SELECT TO authenticated USING (true);
CREATE POLICY "pq_write" ON public.productivity_quality_rates FOR ALL TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin','Production Admin','QC Admin'))
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin','Production Admin','QC Admin'));

-- ---- danh mục / hệ thống ----
CREATE POLICY "cat_read" ON public.shift_classes FOR SELECT TO authenticated USING (true);
CREATE POLICY "cat_write" ON public.shift_classes FOR ALL TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager'))
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager'));

CREATE POLICY "roles_read" ON public.rbac_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY "roles_write" ON public.rbac_roles FOR ALL TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'AD System')
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'AD System');

CREATE POLICY "lines_read" ON public.production_lines FOR SELECT TO authenticated USING (true);
CREATE POLICY "lines_write" ON public.production_lines FOR ALL TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager'))
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager'));

CREATE POLICY "ocr_read" ON public.ocr_scans FOR SELECT TO authenticated USING (true);
CREATE POLICY "ocr_write" ON public.ocr_scans FOR ALL TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin'))
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin'));

CREATE POLICY "settings_read" ON public.app_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "settings_write" ON public.app_settings FOR ALL TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'AD System')
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'AD System');

-- ---- audit logs ----
CREATE POLICY "audit_insert" ON public.user_audit_logs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "audit_select" ON public.user_audit_logs FOR SELECT TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('AD System','HR Manager','HR Admin'));

-- ----------------------------------------------------------------------------
-- 5. Kiểm tra: không còn policy nào trỏ profiles, không còn bảng profiles
-- ----------------------------------------------------------------------------
SELECT policyname, tablename FROM pg_policies
WHERE schemaname = 'public' AND qual LIKE '%profiles%';
SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'profiles';
