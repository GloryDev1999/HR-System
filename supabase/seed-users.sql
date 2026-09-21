-- ============================================================================
-- SmartHR — Seed 6 users Auth + profiles (chạy 1 LẦN trong SQL Editor)
-- Email dạng *@hr.os. Pass mặc định: 123 cho cả 6. User tự đổi trong frontend
-- (avatar góc phải → Đổi mật khẩu, gọi supabase.auth.updateUser).
--
-- Cách chạy: Supabase Dashboard → SQL Editor → New query → paste toàn file → Run.
-- LƯU Ý KỸ THUẬT: bản GoTrue mới dùng PARTIAL unique index cho auth.users.email
-- nên ON CONFLICT (email) báo lỗi 42P10. Script này dùng WHERE NOT EXISTS
-- (chạy lại nhiều lần an toàn, tương thích mọi version).
-- Yêu cầu extension pgcrypto (Supabase cài sẵn; nếu báo thiếu gen_salt thì chạy
-- thêm dòng: create extension if not exists "pgcrypto" with schema "extensions";)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BƯỚC 0: dọn profiles mồ côi (id không còn trong auth.users) để tránh trùng
-- username khi tạo lại. An toàn khi chạy lại nhiều lần.
-- ----------------------------------------------------------------------------
DELETE FROM public.profiles AS p
WHERE NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = p.id);

-- ----------------------------------------------------------------------------
-- BƯỚC 1: tạo 6 users trong auth.users (bcrypt crypt('123', gen_salt('bf'))).
-- ----------------------------------------------------------------------------
INSERT INTO auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
SELECT
  (SELECT id FROM auth.instances LIMIT 1),
  gen_random_uuid(),
  'authenticated', 'authenticated',
  n.email,
  crypt(n.pass, gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(), now()
FROM (VALUES
  ('kieu@hr.os',       '123'),
  ('hoa@hr.os',        '123'),
  ('vinh@hr.os',       '123'),
  ('nguyetanh@hr.os',  '123'),
  ('han@hr.os',        '123'),
  ('glory@hr.os',      '123')
) AS n(email, pass)
WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.email = n.email);

-- ----------------------------------------------------------------------------
-- BƯỚC 2a: bù profile nếu trigger handle_new_user chưa tạo (VD trigger bị tắt).
-- Chạy trước UPDATE để đảm bảo đủ 6 dòng profiles.
-- ----------------------------------------------------------------------------
INSERT INTO public.profiles (id, username, display_name, role)
SELECT u.id, u.email, u.email, 'HR Admin'
FROM auth.users AS u
WHERE u.email LIKE '%@hr.os'
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- BƯỚC 2b: sửa profiles đúng username/display/role/scope.
-- ----------------------------------------------------------------------------
UPDATE public.profiles AS p SET
  username         = m.username,
  display_name     = m.display_name,
  role             = m.role::public.role_type,
  department_scope = m.scope::text,
  active           = true,
  is_locked        = false
FROM (VALUES
  ('kieu',      'Kieu(Mia)',       'AD System',       NULL::text,         'kieu@hr.os'),
  ('hoa',       'Hoa(Molly)',      'HR Manager',      NULL::text,         'hoa@hr.os'),
  ('vinh',      'Vinh(Glory)',     'Warehouse Admin', 'WH'::text,         'vinh@hr.os'),
  ('nguyetanh', 'Nguyet Anh',      'QC Admin',        'QC'::text,         'nguyetanh@hr.os'),
  ('han',       'Han',             'Production Admin','Production'::text, 'han@hr.os'),
  ('glory',     'Glory(Software)', 'AD System',       NULL::text,         'glory@hr.os')
) AS m(username, display_name, role, scope, email)
WHERE p.username = m.email;

-- ----------------------------------------------------------------------------
-- BƯỚC 3: kiểm tra (2 bảng kết quả phải đủ 6 dòng)
-- ----------------------------------------------------------------------------
SELECT email,
       (email_confirmed_at IS NOT NULL) AS confirmed,
       last_sign_in_at
FROM auth.users
WHERE email LIKE '%@hr.os'
ORDER BY email;

SELECT username, display_name, role, department_scope, active, is_locked
FROM public.profiles
ORDER BY username;
