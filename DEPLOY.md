# HƯỚNG DẪN DEPLOY CLOUD — SmartHR Leggett & Platt

Mô hình: **Supabase Cloud (Postgres + Auth + Realtime + Storage) + Cloudflare Pages (static hosting)**.
Không còn máy host LAN, không OneDrive JSON, không IndexedDB nghiệp vụ, không file `.lnk`/`.vbs`/`.bat`.

---

## 1. Yêu cầu

- Tài khoản **Supabase** (1 project, gói free đủ chạy) + quyền mở SQL Editor.
- Tài khoản **Cloudflare** (Pages) + quyền tạo project Pages.
- Máy build: **Git** + **Node.js ≥ 20**.
- Không thực thi file `.exe` nào của dự án.

## 2. Tạo database: chạy `supabase/schema.sql` trong SQL Editor

1. Mở Supabase Dashboard → project → **SQL Editor** → New query.
2. Copy toàn bộ nội dung file `supabase/schema.sql` trong repo, paste và **Run**.
3. Kiểm tra: đủ **13 tables** (`employees`, `shift_classes`, `rbac_roles`,
   `raw_attendance_logs`, `daily_timesheets`, `overtime_records`, `leave_requests`,
   `shift_rosters`, `production_lines`, `productivity_quality_rates`, `ocr_scans`,
   `app_settings`, `user_audit_logs`), RLS bật mọi bảng.
4. Kiểm tra advisors: **Database → Advisors** (Security + Performance) sạch 0 lỗi blocking.

## 3. Tạo 6 users (chuẩn Auth, không bảng phụ)

1. **Authentication → Users → Add user**: tạo 6 acc email `@leggett.com`
   (`vinh` / `hoa` / `kieu` / `nguyetanh` / `han` / `glory`), pass ≥ 6 ký tự,
   bật **Auto Confirm**.
2. Với mỗi user: **... → Edit user → App Metadata**, dán:
   `{"username":"vinh","display_name":"Vinh(Glory)","role":"Warehouse Admin","department_scope":"WH"}`
   (kieu+glory = `AD System`/scope null, hoa = `HR Manager`/scope null,
   han = `Production Admin`/`Production`, nguyetanh = `QC Admin`/`QC`).
   Mẫu SQL có sẵn trong `supabase/seed-users.sql`.
3. Đăng nhập thử 1 acc → vào app thấy đúng quyền theo ma trận `rbac_roles`.

## 4. Cấu hình `.env`

Tạo file `.env` ở root (không commit):

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-public-key>
```

Lấy 2 giá trị tại Supabase Dashboard → **Project Settings → API**.

## 5. Build

```bash
npm install
npm run build        # sinh dist/ multi-file
```

Kiểm tra `dist/` có `index.html` + assets + `PaddleOCR-Models/`
(det + rec + dict + ort wasm) và `public/_headers` (COOP/COEP cho ONNX WASM).

## 6. Deploy `dist/` lên Cloudflare Pages

1. Cloudflare Dashboard → **Workers & Pages → Create → Pages → Upload assets**
   (hoặc connect repo Git để auto-deploy mỗi push).
2. Upload toàn bộ nội dung `dist/` (kèm `_headers`).
3. Mở URL public `https://<project>.pages.dev` → đăng nhập Supabase Auth → dùng.

## 6b. Deploy Edge Function `admin-user` (Kieu tự cấp lại MK, 1 lần)

Không deploy là nút **Đặt lại MK** trong Users báo lỗi thiếu function.

**Cách A — Dashboard (không cần CLI):**
1. Supabase Dashboard → **Edge Functions** → **Create a new function** → tên `admin-user`.
2. Mở file `supabase/functions/admin-user/index.ts` trong repo → copy toàn bộ → paste vào editor → **Deploy**.
3. Không cần set secrets: `SUPABASE_URL` / `ANON_KEY` / `SERVICE_ROLE_KEY` Edge Functions tự có.

**Cách B — CLI:**
```bash
supabase login
supabase link --project-ref <project-ref>
supabase functions deploy admin-user
```

Kiểm tra: Users → **Đặt lại MK** cho 1 acc test → đăng nhập bằng pass mới. Mọi lượt cấp lại ghi audit `RESET_PASSWORD`.

## 7. PaddleOCR-Models serve cùng `dist`

- Mặc định: thư mục `PaddleOCR-Models/` nằm cùng `dist/`, trình duyệt tải model
  qua HTTPS + Cache Storage (không nhúng base64 vào bundle nữa).
- Thay thế (tuỳ chọn): upload models lên **Supabase Storage** (bucket public),
  trỏ `MODEL_BASE_URL` sang URL Storage.

## 8. Cam kết "không chạy .exe" — kết quả audit

| Hạng mục | Kết quả |
|---|---|
| File `.exe` trong repo / dist | **0** |
| Quy trình runtime của app | Trang web tĩnh trên Cloudflare Pages; engine AI là WASM chạy TRONG tab |
| Native binding từ npm | `@rolldown/binding-*`, `@tailwindcss/oxide-*` — thư viện `.node/.dll` **chính thức có ký số của npm**, nạp in-process (KHÔNG phải .exe độc lập) |
