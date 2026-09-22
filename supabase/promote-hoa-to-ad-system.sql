-- ============================================================================
-- SmartHR — Promote hoa@leggett.com lên AD System (full quyền = kieu/glory).
-- Chốt 2026-09-22: kieu = hoa = glory cùng role AD System; 3 dept còn lại
-- (vinh/WH, han/Production, nguyetanh/QC) KHÔNG thay đổi.
-- Role HR Manager trong code vẫn bị chặn Settings/Users (cho acc tương lai).
--
-- Chạy trong Supabase Dashboard → SQL Editor (cần quyền service_role/postgres).
-- Sau khi chạy: đăng xuất acc hoa rồi đăng nhập lại để JWT mới có role mới.
-- ============================================================================

UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data || '{
  "username": "hoa",
  "display_name": "Hoa(Molly)",
  "role": "AD System",
  "department_scope": null
}'::jsonb
WHERE email = 'hoa@leggett.com';

-- Kiểm tra: 3 acc AD System + 3 dept scope
SELECT email,
       raw_app_meta_data ->> 'username' AS username,
       raw_app_meta_data ->> 'role' AS role,
       raw_app_meta_data ->> 'department_scope' AS scope
FROM auth.users
WHERE email LIKE '%@leggett.com'
ORDER BY email;
