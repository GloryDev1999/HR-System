# PIPELINE — Kiến trúc hệ thống SmartHR (Leggett & Platt)

> Review toàn diện ngày 2026-09-20 trên bản clone `HR-System-clone`.
> Mọi khẳng định đều đối chiếu mã nguồn thật (đường dẫn + dòng kèm theo).

---

## 1. Tổng quan 1 hình

```
                    ┌─────────────────────────────────────────────┐
                    │  MÁY HOST (Hoa, IP tĩnh 192.168.1.50)        │
                    │  SmartHR-BangDieuKhien.lnk                   │
                    │   └─ wscript mo-ui.vbs                       │
                    │        ├─ node launcher-ui.js (:4179, loopback)│
                    │        │    └─ spawn node server.js (:4173, LAN)│
                    │        └─ mở browser http://127.0.0.1:4179   │
                    └─────────────────────────────────────────────┘
                         │ LAN 192.168.1.0/24, port 4173
        ┌────────────────┼────────────────┐
   Kieu (full)    Vinh/Han/NguyetAnh     Glory (kỹ thuật)
   login từ xa    (dept, push-only*)     login khi cần
        └────────────────┼────────────────┘
                         ▼
   Mỗi máy: browser → IndexedDB riêng (HRSystem_LeggettPlatt_DB)
   Realtime: SSE presence (chạy) + mutation journal (khung có, chưa đấu dây)
   Fallback: thư mục OneDrive HR_Data (master_*.json / dept_*.json, LWW merge)
```

`*` push-only là quy ước vận hành đã chốt, chưa có enforce trong code (xem report.md).

---

## 2. Vận hành (ai làm gì, mở cái gì)

| Vai trò | Người | Quyền | Cách vào |
|---|---|---|---|
| AD System (master owner) | kieu | Toàn quyền + Settings + Users | Login từ xa qua IP host |
| HR Manager (co-owner, **vận hành chính**) | hoa | Toàn quyền trừ Settings/Users | **Mở `SmartHR-BangDieuKhien` trên Desktop → MỞ SERVER → MỞ HỆ THỐNG** |
| AD System (kỹ thuật) | glory | Toàn quyền | Login khi cần |
| Warehouse Admin | vinh (scope WH) | Sắp ca WH + gửi file `dept_WH_vinh.json` | Mở `http://IP-host:4173` |
| Production Admin | han (scope Production) | Sắp ca + tỷ lệ NS | Mở `http://IP-host:4173` |
| QC Admin | nguyetanh (scope QC) | Sắp ca + tỷ lệ CL | Mở `http://IP-host:4173` |

Luồng mỗi sáng (máy Hoa): double-click shortcut → bảng điều khiển web → **MỞ SERVER** (node ẩn, poll `/api/health` 15s, ghi `HR_Data/_current-host.json`) → **MỞ HỆ THỐNG** (tab login) → dept mở link LAN login acc của mình. Cuối ngày: **TẮT SERVER** (kill theo PID, cảnh báo nếu còn user online). Đóng tab không tắt server.

Seed acc mặc định trong `src/context/AuthContext.tsx:64-80`, pass `123` cho cả 6.

---

## 3. Database — Dexie IndexedDB (`src/db/index.ts`)

* DB `HRSystem_LeggettPlatt_DB`, **14 stores**, migrations **v2 → v9** (giữ tên store camelCase để không mất dữ liệu cũ).
* PK phổ biến `employeeId_date` / `lineId_date` (chuỗi ghép), `rawAttendanceLogs` dùng `++id` auto-increment.
* **Compound indexes** cho query nóng Dashboard/Sidebar/Timesheet (v4): `[month+year]`, `[employeeId+month+year]`, `[statusCode+month+year]`, `[department+status]`, `[verificationStatus+month+year]`, `[lineId+month+year]`…
* **Shadow Flag 0|1** (v6, v9): IndexedDB cấm boolean làm key → `isViolation→isViolationFlag`, `isRestViolation→isRestViolationFlag`, `isShiftMismatch→isShiftMismatchFlag`, `active→activeFlag`, `isRotating→isRotatingFlag`, `isSystem→isSystemFlag`; upgrade transform dữ liệu cũ + Dexie hooks `creating/updating` tự đồng bộ Flag (`src/db/index.ts:273-305`).
* Seed trong migration: 4 ca (`OFFICE_M_F`, `OFFICE_M_S`, `SHIFT_1`, `SHIFT_2`), 6 rbacRoles từ `DEFAULT_SETTINGS`, 2 chuyền `line_rivet_1/2`.
* `DEFAULT_SETTINGS` (`src/db/index.ts:356-393`): ma trận `rolePermissions` 6 roles, công thức thưởng NS/chuyên cần, khấu trừ UL, phụ cấp ca đêm 30%.
* Persistent storage xin 1 lần ở bootstrap (`src/main.tsx:8-10` + `ensurePersistentStorage()`), quota estimate trước import lớn.

Chi tiết stores + index: đọc bảng `this.version(n).stores()` tại `src/db/index.ts:70-271`.

---

## 4. Backend Node (`server.js`, `launcher-ui.js`)

### 4.1. `server.js` — LAN Server & Sync Hub (zero-dependency)
* `node:http/fs/path/os/zlib` thuần túy, RAM < 15MB (streaming + gzip on-the-fly bundle 75MB → ~15MB), listen `0.0.0.0:4173`, chống path-traversal, ETag/304, SPA fallback, header COOP+COEP cho ONNX WASM.
* **5 API**: `GET /api/realtime` (SSE: `presence`, `mutation`, ping 15s) · `POST /api/presence/heartbeat` (online map, timeout 30s) · `POST /api/sync/mutate` (ghi journal RAM 2000 bản ghi + persist debounce 1s xuống `data/lan_master_store.json` + broadcast SSE) · `GET /api/sync/pull?since=` (catch-up) · `GET /api/health` (uptime, LAN IP, online users, mutations).
* Trang chẩn đoán `/status` (`serveStatusPage`): user online, link LAN, nút vào app.

### 4.2. `launcher-ui.js` — Bảng điều khiển (zero-dependency, đã test thật)
* Bind **loopback `127.0.0.1:4179`** (máy khác không điều khiển được), spawn `server.js` bằng array-args + `windowsHide` (không cửa sổ đen), PID ở `%TEMP%/smarthr-server.pid`, ghi `HR_Data/_current-host.json` qua tmp+rename (an toàn OneDrive).
* API: `/api/status|start|stop|quit|hostfile` + page UI inline (3 thẻ nút, pill trạng thái, link LAN copy 1 click, log, stats). **Đã verify end-to-end**: start → health online 4173 → stop → offline → quit sạch PID.
* Chuỗi mở: `SmartHR-BangDieuKhien.lnk` (icon `public/hr-manager.ico`) → `wscript mo-ui.vbs` → node ẩn + mở browser. `launcher.bat/launcher.ps1` (WinForms) là bản cũ, giữ lại không dùng.

---

## 5. Frontend (`src/`)

* `main.tsx` → `App.tsx`: `ErrorBoundary > AuthProvider > LanguageProvider > ToastProvider > ModalProvider > Shell`. Routing thủ công bằng `activePage` (12 `NavPageId`), chưa login → `LoginScreen`.
* Contexts: **Auth** (login/logout/lockout 10 lần, session `sessionStorage`, RBAC `makeHasPermission`: AD System=all, HR Manager=all trừ Settings/Users, còn lại theo ma trận), **Toast**, **Modal** (`confirm/alert/custom`, không alert native trong app React), **Language** (VI/EN).
* Pages (12): Dashboard · EmployeeList · TimesheetCalendar · ProductivityQuality (NS/CL theo chuyền) · Overtime · LeavePending · ShiftAssignment (= nơi merge JSON dept→master, LWW) · AttendanceViolation · OCRVerification · UserManagement (+ audit log) · Settings (RBAC matrix + LAN server tab). Sidebar đếm badge realtime bằng `useLiveQuery` trên chính index Flag v6/v9.
* Services nghiệp vụ: `formula-engine` + `formula-defs` (single-source tính công/phép/phụ cấp) · `timesheet-parser-service` + worker (Excel 20k dòng, clear+bulkPut transaction) · `excel-exporter` · `calendar-utils` · `pay-period` (kỳ công Official 21→20 / Seasonal 1→31) · `audit-log-service` (store `userAuditLogs`) · `hr-rag-postprocessor`.
* Static assets: logo `Leggett.jpg`, favicon, fonts — tương đối (`base './'`) nên sống cả `file://` OneDrive.

---

## 6. Đồng bộ 2 kênh

| Kênh | Cơ chế | Trạng thái |
|---|---|---|
| LAN realtime | SSE presence + heartbeat 10s (`lan-sync-service.ts`, `presence-service.ts`: BroadcastChannel + localStorage + SSE LAN hòa trộn, offline 25-30s) | **Chạy** |
| LAN data | `broadcastMutation` → outbox `syncOutbox` (v10) → `POST /api/sync/mutate` (delete-on-ack, giữ order) → SSE → `applyRemoteMutation` LWW vào Dexie + `pullCatchUp` + `flushOutbox` (tick 15s, SSE open, nút Gửi ngay). Bulk/file-flows suppress + marker `__bulk` (luật kênh: file đi file, LAN chở edit tay) | **Chạy (M23)** |
| OneDrive JSON (phương án A dual-master) | `json-sync-service.ts` (1558 dòng): `master_kieu/hoa/glory.json` + `dept_WH/QC/PRD_*.json`, merge theo PK với LWW + tie-break `kieu>hoa`, field-level cho NS/CL, employees không xóa khi merge, DirectoryHandle lưu IndexedDB + auto-scan 8s, conflict-copy gắn cờ xử lý tay | **Chạy (fallback chính)** |

---

## 7. Auth & mật khẩu

* SHA-256(`salt:password`), salt 16 bytes. WebCrypto khi secure-context, **fallback SHA-256 thuần JS cho `http://IP-LAN`** (kết quả giống hệt FIPS 180-4, có test vector) — `src/services/password.ts`.
* Khóa acc sau 10 lần sai, unlock/reset bởi System Admin (`AuthContext.tsx:188-257,301-…`).

---

## 8. ONNX/OCR (chạy trong browser, không server AI)

* Models `PaddleOCR-Models/`: det `ch_PP-OCRv4` 4.75MB + rec `latin_PP-OCRv3` 9MB + `latin/vi_dict` + `ort-wasm-simd-threaded` 13.5MB.
* Build: `prebuild` (`embed-models.mjs`) base64 toàn bộ vào `src/generated/` (~35MB, không commit) để sống `file://`; sau build copy nguyên thư mục vào `dist/PaddleOCR-Models/` (đã verify đủ 6 file).
* Runtime 3 tầng: worker `onnx-ocr.worker.ts` (DBNet detect → CTC rec → grid, ưu tiên embedded → CacheStorage → fetch) · `ocr-worker-client.ts` (hàng đợi Promise, fallback main-thread khi worker chết) · `ocr-engine-direct.ts` (pipeline main-thread cho `file://`, 1 luồng, wasm từ IndexedDB) · `ocr-assets-store.ts` (cache IDB `HRSystem_OCRAssets`) · `onnx-model-checker.ts` (chuẩn đoán `READY/WARNING/ERROR`, nguồn `embedded/server/idb/mixed`, nút nạp offline).
* `vite.config.ts`: `preventOrtWasmDoubleInline` (tránh nhân 4 wasm ~70MB), `viteSingleFile`, `base './'`, COOP/COEP ở dev/preview cho `SharedArrayBuffer`.

---

## 9. Build / Deploy / Test

* `npm run setup` (= install + build) → `dist/index.html` **75MB single-file** + `PaddleOCR-Models/` + `npm run serve` (:4173) hoặc `node server.js` (LAN). `scripts/make-shortcut.mjs` sinh `SmartHR.url` cho dept; `deploy-to-onedrive.mjs` copy `dist/` theo env `HR_ONEDRIVE_DIST`.
* `DEPLOY.md`: mô hình admin-giữ-repo → client clone → build → chạy local, audit 0 `.exe`, 2 DLL ký số npm cần whitelist (`@rolldown`, `@tailwindcss/oxide`).
* Tests: 11 file vitest, 161 tests (146 gốc + 15 sync-outbox KB-020), tsc 0 lỗi. DB `db.test.ts` assert v10/15 stores.
* Quy ước agent của repo: `agent.md` (evidence-first, local-first, không dialog native), `state.json` (phase 33, v3.1.0), `loop.md/subagent.md/learning.md` (vòng QC).
