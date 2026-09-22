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
   (kieu+hoa+glory = `AD System`/scope null,
   han = `Production Admin`/`Production`, nguyetanh = `QC Admin`/`QC`).
   (Chốt 2026-09-22: hoa đã promote từ HR Manager lên AD System —
   chạy `supabase/promote-hoa-to-ad-system.sql` nếu acc hoa cũ còn role cũ.)
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

## 9. Checklist bảo mật 0đ (làm 1 lần sau deploy)

> LƯU Ý IP: `10.233.98.x` là IP **nội bộ nhà máy (LAN)** — Internet chỉ thấy
> **IP public của router** (mở `https://ifconfig.me` từ 1 máy trong xưởng để lấy).
> Mọi rule allowlist dưới đây dùng **IP public**, không dùng IP 10.x.
> Kiểm tra tĩnh/động: ghi lại IP public → khởi động lại router → so sánh;
> nếu đổi thì gọi ISP (Viettel/VNPT/FPT) hỏi gói IP tĩnh (thường +vài chục nghìn/tháng)
> hoặc dùng rule Challenge thay vì Block cứng (mục 9.3).

### 9.1 Supabase Dashboard (miễn phí)

1. **Đổi ngay mật khẩu mặc định** cả 6 acc (`123456` → ≥10 ký tự, hoa+thường+số+ký hiệu):
   Authentication → Users → từng user → … → Update password.
2. **Tắt đăng ký công khai**: Authentication → Providers → Email →
   tắt **Allow new users to sign up** (hệ thống chỉ có 6 acc cố định).
3. **Bật MFA (app Authenticator, miễn phí)** cho 3 acc admin (kieu/hoa/glory):
   mỗi người tự vào avatar → (luồng MFA) hoặc ép bằng policy nội bộ.
4. **Rút ngắn JWT expiry**: Project Settings → Auth → JWT expiry còn `1800`
   (30 phút, khớp auto-logout client).
5. (Khi lên Pro mới có) Leaked-password check + Network Restrictions.

### 9.2 Cloudflare Pages — WAF custom rules (miễn phí)

Security → WAF → Custom rules (tạo 2 rule, thứ tự ưu tiên từ trên xuống):

1. `CHI PHÉP VIỆT NAM`: `(ip.geoip.country ne "VN")` → **Block**.
   (Nhà máy + HR chỉ làm việc trong nước; chặn 100% scan từ nước ngoài, 0đ.)
2. `ƯU TIÊN IP XƯỞNG`: `(ip.src ne <IP-PUBLIC-XƯỞNG>)` → **Managed Challenge**.
   (Máy xưởng vào thẳng; IP lạ — kể cả trong VN — phải vượt thử thách bot.
   Khi nào có IP tĩnh xác nhận thì đổi sang Block cho kín hoàn toàn.)

### 9.3 Cloudflare — Rate limiting (gói Free có 1 rule)

Security → WAF → Rate limiting rules → Create:

- Expression: `Path` contains `/` (toàn site Pages tĩnh) —
  hoặc thu hẹp khi có custom domain + endpoint riêng.
- Characteristics: IP · Period **10s** · Requests **100** · Mitigation **10s** →
  Action **Managed Challenge**.
- Tác dụng: 1 IP chỉ được ~10 req/s, vượt là ăn challenge 10s — quét tự động
  (scanner/botnet) bị bẻ gãy tốc độ mà user thật không ảnh hưởng.
- Lưu ý đúng kỹ thuật: rule đếm theo IP **nhìn từ Cloudflare** (sau NAT của
  xưởng cả trăm máy chung 1 IP public → ngưỡng 100/10s đủ rộng, không đặt thấp
  kẻo tự chặn chính mình). Brute-force vào **Supabase Auth API đi thẳng,
  không qua Cloudflare** — lớp này chỉ bảo vệ mặt web; chống dò pass thật sự
  nằm ở: throttle client (`login-guard.ts`) + rate-limit server của Supabase +
  tắt signup + MFA + mật khẩu mạnh.

### 9.4 Bot Fight Mode (miễn phí)

Security → Bots → bật **Bot Fight Mode**: chặn bot đã biết (scanner, credential
stuffing tool phổ biến) trước khi chạm tới Pages.

### 9.5 Trong code (đã có sẵn từ Phase M32)

- `login-guard.ts`: sai 5 lần khóa 60s, 8 lần khóa 300s, ≥12 lần khóa 900s.
- Màn hình login **không** in tài khoản/mật khẩu mẫu.
- Tự đăng xuất sau 30 phút không thao tác (`App.tsx`).
- `_headers`: `X-Frame-Options: DENY` (chống clickjacking) + COOP/COEP + nosniff.
- `audit_insert` RLS chỉ cho `authenticated` → attacker ẩn danh không spam được log.
