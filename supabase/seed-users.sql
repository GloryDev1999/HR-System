-- ============================================================================
-- SmartHR — Quản trị users chuẩn Supabase Auth (KHÔNG bảng profiles).
-- Role/scope nằm trong auth.users.raw_app_meta_data (server-side, RLS đọc JWT).
--
-- 6 users đã tạo sẵn qua Admin API (pass 123456):
--   vinh@leggett.com (Warehouse Admin / WH) · hoa@leggett.com (HR Manager)
--   kieu@leggett.com (AD System) · nguyetanh@leggett.com (QC Admin / QC)
--   han@leggett.com (Production Admin / Production) · glory@leggett.com (AD System)
--
-- THÊM USER MỚI: Dashboard Authentication → Add user → Create user,
-- rồi chạy UPDATE bên dưới để gán vai trò (mẫu cho role Warehouse Admin/WH).
-- ============================================================================

-- Mẫu gán vai trò (sửa email + role + scope rồi chạy):
-- UPDATE auth.users
-- SET raw_app_meta_data = raw_app_meta_data || '{
--   "username": "vinh",
--   "display_name": "Vinh(Glory)",
--   "role": "Warehouse Admin",
--   "department_scope": "WH"
-- }'::jsonb
-- WHERE email = 'vinh@leggett.com';

-- ----------------------------------------------------------------------------
-- Kiểm tra: đủ 6 users + đúng role/scope trong app_metadata
-- ----------------------------------------------------------------------------
SELECT email,
       raw_app_meta_data ->> 'username' AS username,
       raw_app_meta_data ->> 'display_name' AS display_name,
       raw_app_meta_data ->> 'role' AS role,
       raw_app_meta_data ->> 'department_scope' AS scope,
       (email_confirmed_at IS NOT NULL) AS confirmed
FROM auth.users
WHERE email LIKE '%@leggett.com'
ORDER BY email;

-- Đổi mật khẩu user khác (khi cần, thay vì Dashboard):
-- UPDATE auth.users
-- SET encrypted_password = crypt('mat-khau-moi', gen_salt('bf')), updated_at = now()
-- WHERE email = 'vinh@leggett.com';
