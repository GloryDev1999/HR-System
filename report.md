# REPORT — Tồn đọng cần xử lý (ưu tiên P0 → P2)

> Đối chiếu mã nguồn thật ngày 2026-09-20. Mỗi mục có bằng chứng + hướng fix.
> **Cập nhật Phase 34 (M23): P0-1 + P0-2 ĐÃ XONG** (outbox v10, 161/161 tests, QC PASS) —
> các mục còn lại giữ nguyên.

---

## P0 — Chặn vận hành LAN realtime, phải làm trước khi giao cho Hoa

### 1. LAN data-sync chết: `broadcastMutation` không ai gọi ✅ ĐÃ FIX (M23)
* **Đã làm:** Dexie hooks → store `syncOutbox` (v10, LOCAL-ONLY) → `flushOutbox()` POST `/api/sync/mutate` (delete-on-ack, giữ order, marker `__bulk` cho bulk) → `applyRemoteMutation` LWW đủ nhánh + guard loop. Banner đếm `syncOutbox.count()`.
* **Bằng chứng:** `src/services/sync-outbox.ts`, `lan-sync-service.ts:flushOutbox/applyRemoteMutation`, `sync-outbox.test.ts` 15 tests, full suite 161/161, tsc 0, QC db+fe PASS. Chi tiết bẫy đã gặp: learning.md KB-020.
* **Còn lại:** push-only của dept mới là quy ước + luật kênh (file cho dept, LAN cho edit tay) — chưa có cờ `canReceive` chặn dept pull (xem mục 2).

### 2. Push-only của 3 dept chưa enforce
* **Bằng chứng:** `applyRemoteMutation` (`lan-sync-service.ts`) nạp mọi mutation cho mọi role; `pullCatchUp` không lọc. (M23 đã thêm LWW + echo nhưng chưa lọc theo role.)
* **Hệ quả:** quy ước "vinh/han/nguyetanh chỉ gửi không nhận" mới nói miệng — máy dept vẫn pull toàn bộ master về.
* **Fix:** cờ `canReceive` theo role (`Warehouse/Production/QC Admin` → skip `applyRemoteMutation` + `pullCatchUp`, vẫn `broadcastMutation`), server giữ journal của họ cho máy full pull.

### 3. Journal `data/` nằm trong OneDrive
* **Bằng chứng:** `server.js:46-47` `DATA_DIR = __dirname/data`; repo đặt trong OneDrive → 2 máy host ở 2 thời điểm + sync liên tục = conflict-copy/lock file journal.
* **Fix:** `DATA_DIR` đọc từ env (vd `SMART_HR_DATA_DIR`, default `%LOCALAPPDATA%/SmartHR`), chỉ code/`dist` nằm OneDrive.

### 4. Hai host cùng lúc = split-brain
* **Bằng chứng:** không có lock nào; `launcher-ui.js` + `server.js` đều cho start vô điều kiện; `_current-host.json` bị ghi đè ai start sau thắng.
* **Fix:** `host.lock` (owner + timestamp + heartbeat) trong `HR_Data`; máy thứ 2 bấm MỞ SERVER khi lock còn sống → chặn + hỏi cướp quyền.

---

## P1 — Làm sau P0, ảnh hưởng trực tiếp UX/bảo mật

### 5. Flow `smarthr://` chết vẫn nằm trong app
* `SettingsPage.tsx:173-406` (register BAT + iframe `smarthr://start`) fragile, đã thay bằng bảng `launcher-ui.js`. Giữ lại gây rối cho Hoa (2 nút mở server cạnh nhau).
* **Fix:** xóa tab `lan-server` launch-flow, chỉ giữ Ping/health + link LAN + nút mở bảng điều khiển `http://127.0.0.1:4179`.

### 6. API LAN không auth
* `server.js:383-439`: `/api/sync/mutate|pull`, `/api/presence/heartbeat` nhận mọi IP LAN, `Access-Control-Allow-Origin: *`.
* Trong 1 LAN chung công ty, ai biết IP cũng push được mutation giả. **Fix tối thiểu:** token chia sẻ trong env + header check; siết hơn: allowlist 6 IP reservation của dept.

### 7. Tài khoản phân mảnh theo máy + pass mặc định `123`
* `ensureDefaultAccounts` (`AuthContext.tsx:34-81`) seed local mỗi browser; đổi pass máy Hoa không lan sang máy khác; cả 6 acc cùng pass `123`, không bắt đổi lần đầu.
* **Fix:** quy ước đổi pass chỉ trên máy host + đồng bộ lại, hoặc centralize auth; bắt buộc đổi pass sau login đầu (hiện `changePassword` tự nguyện).

### 8. `ShiftRosterPage` chết
* Import ở `App.tsx:20` nhưng cả 2 nhánh `shiftRoster`/`shiftAssignment` (`App.tsx:70-72`) đều render `ShiftAssignmentPage`. Page cũ thành code chết.
* **Fix:** xóa import + nhánh thừa, hoặc mount đúng page nếu còn nghiệp vụ riêng.

---

## P2 — Vệ sinh kỹ thuật & nợ nhỏ

### 9. Không build/test được ở bản clone này ✅ ĐÃ XỬ LÝ (M23)
* Đã `npm install --legacy-peer-deps` (bắt buộc vì lock pin vite 8.2.2 trong khi `@vitejs/plugin-react@4.7.0` peer vite ^4–7) + chạy `node scripts/embed-models.mjs` (sinh file generated). Verify: **tsc 0 lỗi, vitest 161/161**.
* Còn lại: `dist/` (build 9/19, 75MB) chưa build lại sau M23 — chạy `npm run build` trên máy Hoa trước khi giao.

### 10. Native `confirm()` trong bảng điều khiển mới
* `launcher-ui.js` (PAGE script) dùng `confirm()` cho Tắt server/quit — trái quy ước `agent.md` "Zero Native Dialogs" (dù trang này nằm ngoài React app).
* **Fix:** thay bằng modal inline khi rảnh.

### 11. Session theo tab + OneDrive conflict-copy tay
* Session `sessionStorage` (`AuthContext.tsx:125-133`): mở tab 2 phải login lại. Conflict-copy OneDrive vẫn nhờ Kieu mở tay (`Header.tsx:1258`). Chấp nhận được, ghi nhận để sau này cải thiện (session `localStorage` + auto-merge conflict).

### 12. File launcher cũ chưa dọn
* `launcher.bat/launcher.ps1` (WinForms), `start-server.bat/hidden.vbs`, `register/unregister-protocol.bat` vẫn nằm root gây nhiễu sau khi chốt `SmartHR-BangDieuKhien`. **Fix:** gom vào `tools/legacy/` hoặc xóa sau khi Hoa chạy ổn 1 tuần. Tương tự `ShiftRosterPage` mục 8.

---

## Thứ tự làm đề xuất

1. P0-1 + P0-2 (đấu dây sync + lọc role) → LAN mới thật sự realtime 2 chiều có kiểm soát.
2. P0-3 + P0-4 (DATA_DIR ngoài OneDrive + host.lock) → hết mất/sai dữ liệu khi đổi host.
3. P1-5 + P1-6 (xóa `smarthr://` + token LAN) → Hoa không bấm nhầm, LAN không bị push bậy.
4. P1-7 + P2-9 (`npm install`, test, build lại `dist/`) → baseline sạch để nghiệm thu.
