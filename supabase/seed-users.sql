-- ============================================================================
-- SmartHR — Seed 6 users Auth + profiles (chạy 1 LẦN trong SQL Editor)
-- Pass mặc định: 123 cho cả 6. User tự đổi trong frontend
-- (avatar góc phải → Đổi mật khẩu, gọi supabase.auth.updateUser).
--
-- Cách chạy: Supabase Dashboard → SQL Editor → New query → paste toàn file → Run.
-- Yêu cầu extension pgcrypto (Supabase cài sẵn; nếu báo thiếu gen_salt thì chạy
-- thêm dòng: create extension if not exists "pgcrypto" with schema "extensions";)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- BƯỚC 1: tạo 6 users trong auth.users (bcrypt crypt('123', gen_salt('bf'))).
-- Chạy lại nhiều lần cũng an toàn (ON CONFLICT DO NOTHING theo email).
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
  ('kieu@smarthr.local',       '123'),
  ('hoa@smarthr.local',        '123'),
  ('vinh@smarthr.local',       '123'),
  ('nguyetanh@smarthr.local',  '123'),
  ('han@smarthr.local',        '123'),
  ('glory@smarthr.local',      '123')
) AS n(email, pass)
ON CONFLICT (email) DO NOTHING;

-- ----------------------------------------------------------------------------
-- BƯỚC 2: sửa profiles do trigger handle_new_user tạo tự động
-- (trigger đặt username = email, role mặc định HR Admin).
-- ----------------------------------------------------------------------------
UPDATE public.profiles AS p SET
  username         = m.username,
  display_name     = m.display_name,
  role             = m.role::public.role_type,
  department_scope = m.scope::text,
  active           = true,
  is_locked        = false
FROM (VALUES
  ('kieu',      'Kieu(Mia)',       'AD System',       NULL::text,            'kieu@smarthr.local'),
  ('hoa',       'Hoa(Molly)',      'HR Manager',      NULL::text,            'hoa@smarthr.local'),
  ('vinh',      'Vinh(Glory)',     'Warehouse Admin', 'WH'::text,            'vinh@smarthr.local'),
  ('nguyetanh', 'Nguyet Anh',      'QC Admin',        'QC'::text,            'nguyetanh@smarthr.local'),
  ('han',       'Han',             'Production Admin','Production'::text,    'han@smarthr.local'),
  ('glory',     'Glory(Software)', 'AD System',       NULL::text,            'glory@smarthr.local')
) AS m(username, display_name, role, scope, email)
WHERE p.username = m.email;

-- ----------------------------------------------------------------------------
-- BƯỚC 3: kiểm tra (2 bảng kết quả phải đủ 6 dòng)
-- ----------------------------------------------------------------------------
SELECT email,
       (email_confirmed_at IS NOT NULL) AS confirmed,
       last_sign_in_at
FROM auth.users
WHERE email LIKE '%@smarthr.local'
ORDER BY email;

SELECT username, display_name, role, department_scope, active, is_locked
FROM public.profiles
ORDER BY username;
