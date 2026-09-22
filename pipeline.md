# PIPELINE — Kiến trúc hệ thống SmartHR (Leggett & Platt)

> Viết lại ngày 2026-09-21 cho kiến trúc Supabase Cloud + Cloudflare Pages.
> Mọi khẳng định đối chiếu mã nguồn thật (đường dẫn + dòng kèm theo).

---

## 1. Tổng quan 1 hình

```
    ┌──────────────────────────────────────────────┐
    │  Cloudflare Pages (static hosting)           │
    │  dist/ multi-file + public/_headers          │
    │  (COOP/COEP cho ONNX WASM, base './')        │
    └──────────────────────────────────────────────┘
                    ▲  HTTPS (URL public)
                    │
    ┌───────────────┴────────────────┐
    │  Browser người dùng (mọi máy)  │
    │  React SPA + AuthContext       │
    │  (Supabase Auth session)       │
    └───────────────┬────────────────┘
                    │  @supabase/supabase-js
                    ▼
    ┌──────────────────────────────────────────────┐
    │  Supabase Cloud (source-of-truth duy nhất)   │
    │  Postgres 14 tables + RLS + Realtime         │
    │  Auth + Storage (PaddleOCR models)           │
    └──────────────────────────────────────────────┘
```

Không còn: máy host `192.168.1.50`, `SmartHR-BangDieuKhien.lnk`, `mo-ui.vbs`, `server.js :4173`, `launcher-ui.js :4179`.

---

## 2. Vận hành (ai làm gì, mở cái gì)

| Vai trò | Người | Quyền | Cách vào |
|---|---|---|---|
| AD System (master owner) | kieu | Toàn quyền + Settings + Users | Login qua URL public (Supabase Auth) |
| AD System (co-owner, **vận hành chính**) | hoa | Toàn quyền + Settings + Users (= kieu/glory) | Login qua URL public (Supabase Auth) |
| AD System (kỹ thuật) | glory | Toàn quyền | Login qua URL public khi cần |
| Warehouse Admin | vinh (scope WH) | Sắp ca WH | Login qua URL public |
| Production Admin | han (scope Production) | Sắp ca + tỷ lệ NS | Login qua URL public |
| QC Admin | nguyetanh (scope QC) | Sắp ca + tỷ lệ CL | Login qua URL public |

Cả 6 users (`vinh` / `hoa` / `kieu` / `nguyetanh` / `han` / `glory`@leggett.com) là Supabase Auth users, vai trò nằm trong App Metadata (không bảng phụ). Không còn thao tác mở server / tắt server / kiểm tra user online trên máy host — mở browser, vào URL public, đăng nhập là làm việc.

---

## 3. Database — Supabase Postgres (`supabase/schema.sql`, 14 tables)

* Postgres trên Supabase Cloud là **source-of-truth duy nhất**, RLS bật mọi bảng.
* **14 tables** (snake_case): `employees`, `profiles`, `shift_classes`, `rbac_roles`, `raw_attendance_logs`, `daily_timesheets`, `overtime_records`, `leave_requests`, `shift_rosters`, `production_lines`, `productivity_quality_rates`, `ocr_scans`, `app_settings`, `user_audit_logs` (13 tables, đã bỏ `profiles`).
* PK phổ biến `employee_id + date` (chuỗi ghép cho timesheet/OT/leave), `raw_attendance_logs` dùng id tự tăng.
* Indexes: FK indexes cho mọi khóa ngoại, partial index cho trạng thái nóng (`PENDING`, violation flags), compound index cho query Dashboard/Timesheet theo `(employee_id, month, year)`.
* Seed: 4 ca (`OFFICE_M_F`, `OFFICE_M_S`, `SHIFT_1`, `SHIFT_2`), 6 `rbac_roles`, 2 chuyền `line_rivet_1/2`, `app_settings` (ma trận `rolePermissions`, công thức thưởng NS/chuyên cần, phụ cấp ca đêm 30%).

Chi tiết DDL + RLS policies + indexes: đọc `supabase/schema.sql`.

---

## 4. Backend Node — ĐÃ XÓA

`server.js` (LAN Server & Sync Hub), `launcher-ui.js` (bảng điều khiển loopback :4179), `.vbs` / `.bat`, `scripts/make-shortcut.mjs`, `scripts/deploy-to-onedrive.mjs` — **tất cả đã xóa khỏi repo**.

Thay thế bằng:
* **Cloudflare Pages**: host static `dist/` build multi-file (thay single-file 75MB cũ).
* **Supabase Realtime**: kênh đồng bộ duy nhất (xem §6).
* Client SDK duy nhất: `@supabase/supabase-js` khởi tạo tại `src/lib/supabaseClient.ts`.

---

## 5. Frontend (`src/`)

* `main.tsx` → `App.tsx`: `ErrorBoundary > AuthProvider > LanguageProvider > ToastProvider > ModalProvider > Shell`. Routing thủ công bằng `activePage` (12 `NavPageId`), chưa login → `LoginScreen`.
* Contexts: **Auth** (`AuthContext` dùng **Supabase Auth**: login/logout/session, RBAC `makeHasPermission`: AD System=all, HR Manager=all trừ Settings/Users, còn lại theo ma trận `rbac_roles`), **Toast**, **Modal** (`confirm/alert/custom`, không alert native trong app React), **Language** (VI/EN).
* Pages (12): Dashboard · EmployeeList · TimesheetCalendar · ProductivityQuality (NS/CL theo chuyền) · Overtime · LeavePending · ShiftAssignment · AttendanceViolation · OCRVerification · UserManagement (+ audit log) · Settings (RBAC matrix). Sidebar đếm badge realtime từ subscription Supabase.
* Services nghiệp vụ: `formula-engine` + `formula-defs` (single-source tính công/phép/phụ cấp) · `timesheet-parser-service` + worker (Excel 20k dòng) · `excel-exporter` · `calendar-utils` · `pay-period` (kỳ công Official 21→20 / Seasonal 1→31) · `audit-log-service` (bảng `user_audit_logs`) · `hr-rag-postprocessor`.
* Static assets: logo `Leggett.jpg`, favicon, fonts — đường tương đối, phục vụ từ Cloudflare Pages.

---

## 6. Đồng bộ — Supabase Realtime

| Kênh | Cơ chế | Trạng thái |
|---|---|---|
| Realtime presence | Channel `presence` — map user online, heartbeat/timeout | **Chạy** (`src/services/lan-sync-service.ts` viết lại dùng Supabase Realtime) |
| Realtime broadcast | Channel `broadcast` — mutation edit tay lan tức thì | **Chạy** |
| Realtime data | `postgres_changes` — subscribe thay đổi Postgres, apply LWW | **Chạy** |

OneDrive JSON (`master_*.json` / `dept_*.json`, merge LWW thủ công, `json-sync-service.ts`, `DirectoryHandle` auto-scan) là **legacy đã bỏ** — không còn trong kiến trúc.

---

## 7. Auth & mật khẩu

* **Supabase Auth** là cơ chế duy nhất: signup/login/session/reset password qua SDK; phân quyền nằm trong Auth App Metadata (+ `rbac_roles` cho ma trận).
* Luồng SHA-256 tay (`salt:password`, WebCrypto + fallback JS thuần cho `http://IP-LAN`, `src/services/password.ts`) và seed 6 acc pass `123` trong `AuthContext` — **đã bỏ**.
* Khóa acc sau nhiều lần sai + unlock/reset bởi System Admin thực hiện trong Supabase Dashboard → Authentication (khóa user, reset pass, sửa App Metadata).

---

## 8. ONNX/OCR (chạy trong browser, không server AI)

* Models `PaddleOCR-Models/`: det `ch_PP-OCRv4` 4.75MB + rec `latin_PP-OCRv3` 9MB + `latin/vi_dict` + `ort-wasm-simd-threaded` 13.5MB.
* Phân phối: serve cùng `dist/` trên Cloudflare Pages (hoặc Supabase Storage) — **bỏ nhúng base64** (`embed-models.mjs` ~35MB vào `src/generated/` đã bỏ).
* Runtime 3 tầng: worker `onnx-ocr.worker.ts` (DBNet detect → CTC rec → grid, ưu tiên Cache Storage → fetch) · `ocr-worker-client.ts` (hàng đợi Promise, fallback main-thread khi worker chết) · `ocr-engine-direct.ts` (pipeline main-thread, 1 luồng) · `ocr-assets-store.ts` (cache IDB `HRSystem_OCRAssets` — đây là **dùng IndexedDB hợp lệ duy nhất còn lại**) · `onnx-model-checker.ts` (chuẩn đoán `READY/WARNING/ERROR`).
* `vite.config.ts`: `preventOrtWasmDoubleInline`, build multi-file, `public/_headers` COOP/COEP cho `SharedArrayBuffer`.

---

## 9. Build / Deploy / Test

* `npm install` → `npm run build` (multi-file `dist/`) → deploy `dist/` lên **Cloudflare Pages** kèm `public/_headers` (COOP/COEP cho ONNX WASM) → `PaddleOCR-Models/` serve cùng `dist/`.
* Chi tiết từng bước: xem `DEPLOY.md` (chạy `supabase/schema.sql` trong SQL Editor, tạo 6 users @leggett.com + App Metadata, cấu hình `.env` `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`).
* Tests: `vitest` + `tsc --noEmit` 0 lỗi. Quy ước agent của repo: `agent.md` (evidence-first, Supabase cloud, không dialog native), `state.json`, `loop.md` / `subagent.md` / `learning.md` (vòng QC với `supabase-qc-architect` + `fe-formula-qc`).
