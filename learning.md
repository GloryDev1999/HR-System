# LEARNING & FAST-FIX LOGBOOK (LEARNING.MD)

Sổ tay ghi nhận toàn bộ các lỗi phát sinh trong quá trình phát triển, nguyên nhân gốc rễ, phương án khắc phục và bài học kinh nghiệm để Coder (Agy CLI) tra cứu và xử lý nhanh chóng nếu gặp lại.

> **THÔNG BÁO KIẾN TRÚC 2026-09-21:** Hệ thống đã chuyển từ Local-First (Dexie/IndexedDB + server.js LAN + OneDrive JSON + single-file offline) sang **Supabase Cloud (Postgres + Auth + Realtime + RLS) + Cloudflare Pages**. Các KB dưới đây gắn tag:
> - `[RETIRED]` KB-002, KB-003, KB-006, KB-009, KB-010 (premature-clear Dexie part), KB-015, KB-016, KB-017 (đã thay bằng cloud fetch), KB-018, KB-019 — chỉ còn giá trị lịch sử, KHÔNG áp dụng cho code mới.
> - `[GIỮ]` KB-001, KB-004, KB-005, KB-007, KB-008, KB-011, KB-012, KB-013 — logic UI/công thức/OCR độc lập backend, vẫn hiệu lực.

---

## Mục lục lỗi & bài học

- [KB-021: Migrate Dexie → Supabase (mapping, TIME, Flag, RLS, cloud build)](#kb-021-migrate-dexie--supabase)

- [KB-001: Lỗi tràn chữ / rớt dòng badge trên màn hình laptop (13-15.6 inch)](#kb-001-lỗi-tràn-chữ--rớt-dòng-badge-trên-màn-hình-laptop-13-156-inch)
- [KB-002: Lỗi IndexedDB không cho phép Boolean làm Index Key](#kb-002-lỗi-indexeddb-không-cho-phép-boolean-làm-index-key)
- [KB-003: Dexie.js upgrade() không chạy trên Fresh Database Install](#kb-003-dexiejs-upgrade-không-chạy-trên-fresh-database-install)
- [KB-004: Giá trị số 0 bị coi là truthy trong Nullish Coalescing (??) khi tính phụ cấp](#kb-004-giá-trị-số-0-bị-coi-là-truthy-trong-nullish-coalescing--khi-tính-phụ-cấp)
- [KB-005: Tách riêng Off và UL: Cần cập nhật cả test suite cũ (timesheet-rules.test.ts)](#kb-005-tách-riêng-off-và-ul-cần-cập-nhật-cả-test-suite-cũ-timesheet-rulestestts)
- [KB-006: Thiếu polyfill fake-indexeddb/auto khi chạy file unit test Dexie độc lập](#kb-006-thiếu-polyfill-fake-indexeddbauto-khi-chạy-file-unit-test-dexie-độc-lập)
- [KB-007: Dashboard KPI vi phạm chuyên cần luôn bằng 0 do lọc nhầm mã công (`code === 'W' || code === 'N'`)](#kb-007-dashboard-kpi-vi-phạm-chuyên-cần-luôn-bằng-0-do-lọc-nhầm-mã-công-code--w--code--n)
- [KB-008: Truy vấn kỳ công 21-20 (Split Month) bỏ sót các ngày của tháng trước nếu chỉ query theo `selectedMonth`](#kb-008-truy-vấn-kỳ-công-21-20-split-month-bỏ-sót-các-ngày-của-tháng-trước-nếu-chỉ-query-theo-selectedmonth)
- [KB-009: Thiếu store mới trong OneDrive Snapshot Sync v3.1](#kb-009-thiếu-store-mới-trong-onedrive-snapshot-sync-v31)
- [KB-010: Mất dữ liệu khi Import do xóa dữ liệu quá sớm trước khi import hoàn tất (Premature Clear Anti-pattern)](#kb-010-mất-dữ-liệu-khi-import-do-xóa-dữ-liệu-quá-sớm-trước-khi-import-hoàn-tất-premature-clear-anti-pattern)
- [KB-011: Lỗi phân quyền menu RBAC (F6) và quyền sửa dữ liệu của Trưởng bộ phận](#kb-011-lỗi-phân-quyền-menu-rbac-f6-và-quyền-sửa-dữ-liệu-của-trưởng-bộ-phận)
- [KB-012: Lỗi tính thử việc bị lệch do định dạng ngày ISO YYYY-MM-DD (B11)](#kb-012-lỗi-tính-thử-việc-bị-lệch-do-định-dạng-ngày-iso-yyyy-mm-dd-b11)
- [KB-013: OCR chỉ cần MSNV, Ngày, Giờ — Tránh biến đổi ký tự tự do làm hỏng tên tiếng Việt (B31)](#kb-013-ocr-chỉ-cần-msnv-ngày-giờ--tránh-biến-đổi-ký-tự-tự-do-làm-hỏng-tên-tiếng-việt-b31)
- [KB-015: Lỗi dynamic import() file:// trên ONNX Runtime Web (`TypeError: Failed to fetch dynamically imported module ... ort-wasm-simd-threaded.mjs`)](#kb-015-lỗi-dynamic-import-file-trên-onnx-runtime-web-typeerror-failed-to-fetch-dynamically-imported-module--ort-wasm-simd-threadedmjs)
- [KB-016: Lỗi Web Worker bị chặn trên giao thức file:// khi nạp file chấm công (`Lỗi Web Worker`)](#kb-016-lỗi-web-worker-bị-chặn-trên-giao-thức-file-khi-nạp-file-chấm-công-lỗi-web-worker)
- [KB-017: Chuyển hoàn toàn Timesheet Parser sang Pure In-Memory, loại bỏ triệt để lỗi Web Worker](#kb-017-chuyển-hoàn-toàn-timesheet-parser-sang-pure-in-memory-loại-bỏ-triệt-để-lỗi-web-worker)
- [KB-018: File .bat UTF-8 có dấu gây vỡ lệnh cmd.exe + pattern one-click Falcon-safe](#kb-018-file-bat-utf-8-có-dấu-tiếng-việt-gây-vỡ-lệnh-cmdexe--pattern-one-click-falcon-safe)
- [KB-019: Dấu & trong đường dẫn OneDrive (Leggett & Platt) cắt lệnh reg + Delayed Expansion](#kb-019-dấu--trong-đường-dẫn-onedrive-leggett--platt-cắt-lệnh-reg--delayed-expansion)

---

### KB-001: Lỗi tràn chữ / rớt dòng badge trên màn hình laptop (13-15.6 inch)
- **Ngày ghi nhận**: 2026-09-09
- **Vị trí**: `src/pages/EmployeeListPage.tsx` (cột Nhóm Ca Làm Việc, Hợp Đồng & Kỳ Công)
- **Triệu chứng (Symptom)**: 
  - Trên màn hình lớn 27 inch hiển thị bình thường: `Chính thức (21-20)`, `HC T2-T6 (23 công)`.
  - Khi mở hệ thống trên laptop (13 – 15.6 inch), bảng tính bị co hẹp, trình duyệt tự động ngắt dòng tại khoảng trắng trước số `20` hoặc chữ `công`, làm rớt chữ xuống dòng thứ 2 trông rất phản cảm và giảm trải nghiệm.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Các phần tử badge `<span>` chưa có class `whitespace-nowrap inline-block`.
  - Thẻ `<th>` và `<td>` của cột chưa được khai báo độ rộng tối thiểu an toàn (`min-w-[155px]`, `min-w-[165px]`).
- **Giải pháp xử lý (Resolution)**:
  - Thêm `whitespace-nowrap inline-block` vào mọi thẻ badge.
  - Bổ sung `min-w-[...]` cho cả `th` và `td` tương ứng.
  - Bao bọc toàn bảng trong container `overflow-x-auto` để cuộn ngang an toàn khi màn hình thu nhỏ thay vì ép hẹp nội dung cột.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Mọi cột bảng hiển thị các cụm từ quan trọng kèm số trong ngoặc (vd `(21-20)`, `(23 công)`) BẮT BUỘC phải có `whitespace-nowrap` ngay từ khi dựng UI, không phụ thuộc vào kích thước màn hình test ban đầu.

---

### KB-002: Lỗi IndexedDB không cho phép Boolean làm Index Key
- **Ngày ghi nhận**: 2026-08-28
- **Vị trí**: `src/db/index.ts`
- **Triệu chứng (Symptom)**:
  - IndexedDB báo lỗi `DataError: The data provided to an operation does not meet requirements` khi truy vấn index trên các trường boolean (`isViolation`, `isRestViolation`, `active`).
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Chuẩn W3C IndexedDB spec chỉ cho phép kiểu dữ liệu: Number, String, Date, Binary, Array làm Index Key. Kiểu `Boolean` không phải là valid key path trong IndexedDB.
- **Giải pháp xử lý (Resolution)**:
  - Tạo shadow flag dạng số `0 | 1` (như `isViolationFlag: 0 | 1`, `activeFlag: 0 | 1`) để dùng cho index.
  - Giữ nguyên trường boolean gốc để React UI binding tự nhiên mà không bị gãy.
  - Dùng Dexie hooks (`creating`, `updating`) hoặc upgrade transform tự động gán `flag = bool ? 1 : 0`.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Khi thiết kế schema Dexie.js, tuyệt đối không đặt index trên trường boolean thuần túy. Luôn chuẩn bị sẵn shadow flag số `0 | 1`.

### KB-003: Dexie.js upgrade() không chạy trên Fresh Database Install
- **Ngày ghi nhận**: 2026-09-09
- **Vị trí**: `src/db/index.ts` & `src/services/db-seeder.ts`
- **Triệu chứng (Symptom)**: 
  - Khách hàng mới mở web app lần đầu trên trình duyệt sạch (chưa có IndexedDB từ trước), các bảng mới (`productionLines`, `shiftClasses`, `rbacRoles`) bị trống rỗng dữ liệu seed ban đầu mặc dù đã viết hàm `.upgrade()` rất cẩn thận.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Cơ chế của Dexie.js: Hàm `.upgrade()` chỉ được trigger khi database đang ở version cũ (ví dụ client đã có DB v6) và mở mã nguồn mới có schema v7. Nếu trình duyệt chưa từng có DB (fresh install), Dexie khởi tạo thẳng version cao nhất hiện tại (v7) và bỏ qua toàn bộ chuỗi `.upgrade()`.
- **Giải pháp xử lý (Resolution)**:
  - Luôn đồng bộ 2 tầng:
    1. Tầng 1: Viết `.upgrade()` trong `src/db/index.ts` cho các client cũ nâng cấp.
    2. Tầng 2: Thêm kiểm tra `count === 0` trong `seedDatabaseIfEmpty()` (`src/services/db-seeder.ts`) cho các client mới truy cập lần đầu.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Bất cứ khi nào tạo store mới cần seed mặc định, phải bổ sung cả trong `.upgrade()` và `seedDatabaseIfEmpty()`.

---

### KB-004: Giá trị số 0 bị coi là truthy trong Nullish Coalescing (??) khi tính phụ cấp
- **Ngày ghi nhận**: 2026-09-09
- **Vị trí**: `src/services/formula-engine.ts`
- **Triệu chứng (Symptom)**: 
  - Nhân viên có `customAllowances.productivityBonus = 0` (chưa cấu hình thưởng riêng), khi tính năng suất Nhóm 2 hệ thống lấy luôn `baseRate = 0` thay vì fallback về mức chuẩn `1.000.000đ`, dẫn đến kết quả tính ra `0đ`.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Toán tử `??` (Nullish Coalescing) chỉ coi `null` và `undefined` là nullish. Số `0` được coi là một giá trị hợp lệ. Khi một nhân viên có `productivityBonus: 0` được khởi tạo mặc định trong mock object, biểu thức `opts.base ?? emp.allowance ?? 1000000` sẽ trả về `0`.
- **Giải pháp xử lý (Resolution)**:
  - Với các trường số tiền mà `0` có nghĩa là "chưa thiết lập / áp dụng mức chuẩn", phải kiểm tra rõ `allowance > 0` trước khi gán: `allowance && allowance > 0 ? allowance : defaultRate`.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Cẩn trọng khi dùng toán tử `??` với các trường số học có giá trị mặc định là 0.

---

### KB-005: Tách riêng Off và UL: Cần cập nhật cả test suite cũ (timesheet-rules.test.ts)
- **Ngày ghi nhận**: 2026-09-09
- **Vị trí**: `src/test/timesheet-rules.test.ts`
- **Triệu chứng (Symptom)**: 
  - Test cũ `handles OFF, Off, ML, LA, ED, MCO, MCI correctly` bị fail vì assert `bag.countUL` kỳ vọng = 2 do ngày trước `Off` được cộng dồn vào `UL`.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Khi tách riêng `Off` (không phép) và `UL` (có phép), `bag.countUL` chỉ đếm số ngày `UL` thực tế. Test cũ đưa vào `OFF` và `Off` mà không có cell `UL` nào, nên `countUL` = 0 và `countOff` = 2.
- **Giải pháp xử lý (Resolution)**:
  - Cập nhật test case legacy sang kỳ vọng chuẩn mới: `bag.countOff === 2` và `bag.countUL === 0`, đồng thời kiểm tra thêm `bag.countML === 1`.

---

### KB-006: Thiếu polyfill fake-indexeddb/auto khi chạy file unit test Dexie độc lập
- **Ngày ghi nhận**: 2026-09-09
- **Vị trí**: `src/test/productivity-quality.test.ts`
- **Triệu chứng (Symptom)**:
  - Chạy toàn bộ test suite (`npm test`) thì pass do file `src/db/db.test.ts` chạy trước và inject `fake-indexeddb/auto` vào global scope của worker. Tuy nhiên khi chạy riêng file test đơn lẻ `npx vitest run src/test/productivity-quality.test.ts`, test fail 100% với lỗi `DatabaseClosedError: MissingAPIError IndexedDB API missing`.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Vitest chạy các file test trong môi trường độc lập (isolated processes/threads). File test mới thao tác trực tiếp với Dexie nhưng không import polyfill `fake-indexeddb/auto` ở đầu file.
- **Giải pháp xử lý (Resolution)**:
  - Thêm `import 'fake-indexeddb/auto';` ngay tại dòng đầu tiên của mọi file test có tương tác với Dexie / IndexedDB.
  - Bổ sung kiểm tra `if (!db.isOpen()) await db.open();` trong `beforeEach`.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Mọi test file liên quan đến Dexie BẮT BUỘC phải import `fake-indexeddb/auto` và luôn test thử bằng lệnh chạy đơn lẻ `npx vitest run <test-file>` trước khi bàn giao cho Subagent QC.

---

### KB-007: Dashboard KPI vi phạm chuyên cần luôn bằng 0 do lọc nhầm mã công (`code === 'W' || code === 'N'`)
- **Ngày ghi nhận**: 2026-09-09
- **Vị trí**: `src/pages/DashboardPage.tsx`
- **Triệu chứng (Symptom)**: 
  - Thống kê trên Dashboard tại KPI Card 2 luôn hiển thị: `0 Đi trễ`, `0 Về sớm`, `0 Quên quẹt vào`, `0 Quên quẹt ra` dù bảng chấm công có nhiều bản ghi trễ và quên quẹt thẻ.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Vòng lặp tính toán kiểm tra điều kiện `if (code !== 'W' && code !== 'N') return;` với giả định ngày công chỉ là W hoặc N. Tuy nhiên, khi nhân viên đi trễ (2'-60') hoặc về sớm, mã trạng thái công là `LA` (Late Arrival) hoặc `ED` (Early Departure); khi quên quẹt thẻ là `MCO` hoặc `MCI`. Do đó, toàn bộ các vi phạm này bị lọc bỏ ngay tại đầu vòng lặp.
- **Giải pháp xử lý (Resolution)**:
  - Định nghĩa helper `isAttendanceRecord`: chấp nhận các mã `['W', 'N', 'LA', 'ED', 'MCO', 'MCI', 'Off', 'OFF']` hoặc `code.startsWith('W')`.
  - Đồng thời tách kiểm tra vi phạm theo cả mã trạng thái và số phút / quẹt thực tế: `code === 'LA' || (lateMinutes > 0 && lateMinutes < 60)`.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Không bao giờ giả định một cell chấm công có vi phạm sẽ giữ nguyên mã chuẩn `W`. Mọi hàm lọc tập hợp ngày công phải kiểm tra bao quát toàn bộ danh mục mã công hiện diện (`isAttendanceRecord`).

---

### KB-008: Truy vấn kỳ công 21-20 (Split Month) bỏ sót các ngày của tháng trước nếu chỉ query theo `selectedMonth`
- **Ngày ghi nhận**: 2026-09-09
- **Vị trí**: `src/pages/ProductivityQualityPage.tsx`, `src/services/excel-exporter.ts`
- **Triệu chứng (Symptom)**: 
  - Trong kỳ công Chính thức (21 tháng N-1 đến 20 tháng N), tỷ lệ năng suất và chất lượng các ngày 21 đến 31 của tháng trước bị biến mất hoặc không nạp được vào bảng chấm công và file Excel.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Dexie query chỉ lọc `where('month').equals(selectedMonth)`. Trong kỳ công 21-20, 11 ngày đầu tiên thuộc tháng N-1 nên có `month === selectedMonth - 1`, dẫn tới bị loại khỏi kết quả query.
- **Giải pháp xử lý (Resolution)**:
  - Khi `cycleMode === 'OFFICIAL'`, nạp đồng thời bản ghi của cả 2 tháng: `month = selectedMonth` và `month = prevMonth`, sau đó lọc bằng tập hợp ngày chính xác (`calendarDays`).
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Khi làm việc với kỳ công vắt qua 2 tháng (21-20), mọi truy vấn IndexedDB theo tháng lịch BẮT BUỘC phải lấy cả 2 tháng tương ứng.

---

### KB-009: Thiếu store mới trong OneDrive Snapshot Sync v3.1
- **Ngày ghi nhận**: 2026-09-09
- **Vị trí**: `src/services/db-sync.ts`
- **Triệu chứng (Symptom)**: 
  - Khi người dùng xuất Snapshot ra file JSON để đồng bộ sang máy khác hoặc sao lưu OneDrive, hai bảng mới `productionLines` và `productivityQualityRates` không được xuất ra. Khi import vào máy mới, cấu hình chuyền sản xuất và tỷ lệ năng suất bị mất.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Interface `IDatabaseSnapshot` và các hàm `exportDatabaseToSnapshot`, `validateSnapshot`, `importDatabaseFromSnapshot` chưa được cập nhật khi schema Dexie nâng cấp thêm store mới.
- **Giải pháp xử lý (Resolution)**:
  - Bổ sung `productionLines` và `productivityQualityRates` vào `IDatabaseSnapshot` (version bump lên `3.1`).
  - Đảm bảo cơ chế backward-compatible: nếu snapshot cũ v3.0 thiếu 2 trường này thì fallback mảng rỗng `[]` và tự động seed chuyền mặc định.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Bất cứ khi nào thêm store mới vào IndexedDB theo kiến trúc Local-First, BẮT BUỘC phải cập nhật ngay module Backup/Restore (`db-sync.ts`).

---

### KB-010: Mất dữ liệu khi Import do xóa dữ liệu quá sớm trước khi import hoàn tất (Premature Clear Anti-pattern)
- **Ngày ghi nhận**: 2026-09-09
- **Vị trí**: `src/components/layout/Header.tsx`
- **Triệu chứng (Symptom)**: 
  - Trong quá trình nạp tệp Excel chấm công / quẹt thẻ / tăng ca, nếu file Excel bị lỗi định dạng hoặc trình duyệt gặp sự cố tại bước 3 (40%), toàn bộ dữ liệu lịch sử quẹt thẻ và chấm công đã bị mất sạch do hàm `clear()` được gọi quá sớm trước khi parse xong.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Gọi `db.dailyTimesheets.clear()`, `db.overtimeRecords.clear()`, v.v. tại bước 3, phân tán độc lập với lệnh `bulkPut()` ở bước 6. Thao tác không nằm trong một transaction nguyên tử (atomic transaction).
- **Giải pháp xử lý (Resolution)**:
  - Bỏ hoàn toàn các lệnh `clear()` tại bước 3.
  - Gom toàn bộ thao tác xoá và ghi đè vào 1 transaction duy nhất: `await db.transaction('rw', [db.dailyTimesheets, db.overtimeRecords, db.rawAttendanceLogs, db.leaveRequests, db.shiftRosters], async () => { ... })` ở bước 6 (90%).
  - Nếu có bất kỳ ngoại lệ nào xảy ra trong quá trình xử lý, toàn bộ transaction tự động rollback 100%, bảo vệ dữ liệu cũ nguyên vẹn.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Trong hệ thống Local-First, KHÔNG BAO GIỜ xóa dữ liệu cũ khi dữ liệu mới chưa được parse và xác thực thành công. Luôn bọc `clear()` và `bulkPut()` trong cùng một Dexie transaction nguyên tử.

---

### KB-011: Lỗi phân quyền menu RBAC (F6) và quyền sửa dữ liệu của Trưởng bộ phận
- **Ngày ghi nhận**: 2026-09-09
- **Vị trí**: `src/components/layout/Sidebar.tsx`, `src/pages/EmployeeListPage.tsx`, `src/pages/ProductivityQualityPage.tsx`, `src/pages/ShiftRosterPage.tsx`, `src/pages/OvertimePage.tsx`, `src/pages/OCRVerificationPage.tsx`
- **Triệu chứng (Symptom)**:
  - Theo phản ánh nghiệp vụ F6, user không có quyền vẫn nhìn thấy menu Danh sách nhân viên trong thanh điều hướng và có thể sửa thông tin nhân viên. Ngược lại, các vai trò Quản lý bộ phận (Warehouse Lead, Production Supervisor, QC Inspector) có quyền cấp bộ phận (`PROPOSE_DEPT_OT`, `MANAGE_DEPT_ROSTER`, `SCAN_DEPT_OCR`, `VIEW_DEPT_EMPLOYEES`) lại bị chặn khi thực hiện các thao tác sửa đổi trong phạm vi bộ phận.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - `Sidebar.tsx` render trực tiếp danh sách menu mà không kiểm tra quyền `hasPermission()`. Các trang chi tiết chỉ kiểm tra quyền toàn quyền (`MANAGE_OT`, `MANAGE_ROSTER`, `SCAN_OCR`) mà bỏ sót các quyền bộ phận tương ứng.
- **Giải pháp xử lý (Resolution)**:
  - Bọc tất cả các menu trong `Sidebar.tsx` với điều kiện `hasPermission()`.
  - Phân quyền ẩn hiện nút sửa/xóa tại `EmployeeListPage` (`hasPermission('MANAGE_EMPLOYEES')`) và `ProductivityQualityPage` (`canManage`).
  - Hỗ trợ đầy đủ quyền bộ phận: `canManageRoster = hasPermission('MANAGE_ROSTER') || hasPermission('MANAGE_DEPT_ROSTER')`, `canManageOt = hasPermission('MANAGE_OT') || hasPermission('PROPOSE_DEPT_OT')`, `canCommit = hasPermission('SCAN_OCR') || hasPermission('SCAN_DEPT_OCR')`.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Luôn đảm bảo nguyên tắc kép: RBAC cấp Menu (UI Visibility) + RBAC cấp Hành động (Action Guard) phải khớp nhau và hỗ trợ cả quyền Global lẫn Department Scope.

---

### KB-012: Lỗi tính thử việc bị lệch do định dạng ngày ISO YYYY-MM-DD (B11)
- **Ngày ghi nhận**: 2026-09-09
- **Vị trí**: `src/services/formula-engine.ts`, `src/workers/formula-engine.worker.ts`, `src/services/pay-period.ts`
- **Triệu chứng (Symptom)**:
  - Nhân viên đang trong thời gian thử việc nhưng vẫn được nhận thưởng năng suất Nhóm 2 nếu trường ngày thử việc `probationEndDate` được lưu theo định dạng `YYYY-MM-DD` (hoặc ISO string) từ trình duyệt. Ngoài ra, tính toán trong Web Worker chạy ngầm không kiểm tra ngày thử việc.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Hàm tính thử việc dùng `probationEndDate.split('/')`, chỉ parse được `DD/MM/YYYY`. Khi chuỗi có dạng `YYYY-MM-DD`, `split('/')` trả về mảng 1 phần tử dẫn đến `isProbation` luôn là `false`. Web worker hoàn toàn thiếu logic kiểm tra thử việc cho Nhóm 2.
- **Giải pháp xử lý (Resolution)**:
  - Nâng cấp `parseDateLoose` hỗ trợ cả `DD/MM/YYYY`, `YYYY-MM-DD`, và ISO string có timestamp `T`.
  - Dùng `parseDateLoose` trong `formula-engine.ts` và đồng bộ logic kiểm tra thử việc vào `formula-engine.worker.ts`.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Khi xử lý dữ liệu ngày tháng từ người dùng hoặc hệ thống, không bao giờ giả định một định dạng chuỗi duy nhất. Mọi hàm engine tính toán và Worker phải đồng bộ 100% logic nghiệp vụ.

---

### KB-013: OCR chỉ cần MSNV, Ngày, Giờ — Tránh biến đổi ký tự tự do làm hỏng tên tiếng Việt (B31)
- **Ngày ghi nhận**: 2026-09-09
- **Vị trí**: `src/services/hr-rag-postprocessor.ts`, `src/pages/OCRVerificationPage.tsx`
- **Triệu chứng (Symptom)**:
  - Khi nhận diện phiếu tăng ca OCR, họ tên tiếng Việt của nhân viên bị méo mó, biến thành số (ví dụ: "Long" thành "10ng", "Sơn" thành "5ơn").
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Từ điển `HR_RAG_CONTEXT.corrections` chứa các phép thay thế ký tự đơn lẻ ('O'->'0', 'l'->'1', 'S'->'5', 's'->'5', 'o'->'0', 'z'->'2') và áp dụng toàn cục trên toàn bộ văn bản của ô dữ liệu.
- **Giải pháp xử lý (Resolution)**:
  - Xóa bỏ các quy tắc thay thế ký tự đơn lẻ toàn cục khỏi từ điển corrections. Giữ các quy tắc trích xuất số chuyên biệt trong `extractCanonicalHRKey` chỉ áp dụng riêng cho tiền tố/hậu tố mã nhân viên.
  - Thực hiện đúng nghiệp vụ đã làm rõ: OCR chỉ tập trung bóc tách chuẩn 3 thông tin: **Mã nhân viên (MSNV)**, **Ngày tăng ca**, và **Số giờ tăng ca**.
  - Tự động tra cứu Họ tên nhân viên và Bộ phận từ danh mục nhân sự Master (`db.employees`) thông qua MSNV đã chuẩn hóa.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Không OCR những thông tin đã có sẵn và chuẩn xác trong cơ sở dữ liệu Master. Tận dụng Master Data Lookup bằng khóa chính để đạt độ chính xác 100% cho các trường định danh.


---

### KB-014: Worker rời bị chặn trên `file://` origin 'null' — inline toàn bộ Worker + nhúng model base64 (update-model.md)
- **Ngày ghi nhận**: 2026-09-10
- **Vị trí**: `src/components/layout/Header.tsx`, `src/services/ocr-worker-client.ts`, `src/workers/onnx-ocr.worker.ts`, `src/services/onnx-model-checker.ts`, `scripts/embed-models.mjs`, `package.json`
- **Triệu chứng (Symptom)**:
  - Mở `dist/index.html` bằng double-click (OneDrive, Edge): OCR không load model; nạp chấm công báo `Failed to construct 'Worker': Script at 'file:///.../dist/timesheet-parser.worker-*.js' cannot be accessed from origin 'null'`. Qua `npm run serve` (http) thì chạy tốt.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Chromium áp origin `null` cho `file://` và chặn Worker fetch file `.js` rời + `fetch()` model `.onnx/.wasm` rời. Build cũ tách worker thành `dist/*.worker-*.js` nên 100% fail ở local. Ngoài ra mở nhầm `index.html` của bản build cũ sau khi đã fix cũng tái hiện đúng lỗi (hash `DKe9plTH` trong log chính là file worker của bản cũ).
- **Giải pháp xử lý (Resolution)**:
  - Cả 2 điểm khởi tạo Worker chuyển sang Vite `?worker&inline` (Header timesheet-parser, ocr-worker-client onnx-ocr). `formula-engine.worker.ts` là orphan (không nơi nào `new Worker`), giữ nguyên.
  - `scripts/embed-models.mjs` (chạy ở `prebuild`) nhúng 6 file thật sự được load (det 4.6MB + latin rec 8.6MB + ort wasm 13MB + mjs + 2 dict) thành base64 vào `src/generated/embedded-models.ts` (~35MB, `@ts-nocheck`, gitignore, không commit). Bỏ `ch_PP-OCRv4_rec.onnx` (11MB, không code nào load) tiết kiệm ~15MB base64.
  - Worker OCR đọc model embedded-trước-fetch-sau; wasm runtime phục vụ qua fetch-patch (pattern đã chứng minh ở `ocr-engine-direct.ts`), không giả định shape object `wasmPaths` theo version ORT (thực tế cài ORT 1.27.0, package khai ^1.24.3).
  - Main thread KHÔNG import bản nhúng (tránh nhân đôi 35MB); health-check đọc `embedded-manifest.ts` tí hon (vài trăm bytes) nên báo đúng `assetSource='embedded'` trên `file://`, hết cảnh báo "Nạp model offline" giả.
  - `deploy-to-onedrive` dùng env `HR_ONEDRIVE_DIST` thay vì hardcode username Windows.
  - Kết quả: `tsc` 0 lỗi, vitest 118/118 pass, `dist/index.html` 38MB một file duy nhất, không còn `*.worker-*.js`.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Mọi file worker/model rời đều chết trên `file://` — luật bất biến: bundle single-file thì worker + model cũng phải inline. Sau mỗi lần sửa code phải build lại + copy đúng `index.html` mới sang OneDrive; log lỗi mà còn trỏ `dist/*.worker-*.js` nghĩa là đang mở bản cũ.

---

### KB-015: Lỗi dynamic import() file:// trên ONNX Runtime Web (`TypeError: Failed to fetch dynamically imported module ... ort-wasm-simd-threaded.mjs`)
- **Ngày ghi nhận**: 2026-09-11
- **Vị trí**: `vite.config.ts`, `src/workers/onnx-ocr.worker.ts`, `src/services/ocr-engine-direct.ts`
- **Triệu chứng (Symptom)**:
  - Khi mở file `dist/index.html` trực tiếp qua đường dẫn `file:///C:/Users/.../dist/index.html` (chạy offline trên OneDrive/Edge) và quét ảnh OCR, hệ thống báo lỗi:
    `image.png: no available backend found. ERR: [wasm] TypeError: Failed to fetch dynamically imported module: file:///C:/Users/bbuvqp1/OneDrive%20-%20Leggett%20&%20Platt,%20Incorporated/HR-System/dist/ort-wasm-simd-threaded.mjs`
- **Nguyên nhân gốc rễ (Root Cause)**:
  1. Trong `vite.config.ts`, cấu hình `conditions: ['onnxruntime-web-use-extern-wasm']` ép Vite nạp bản `ort.min.mjs` (bản extern-wasm). Trong bản này, factory module Emscripten (`Xr`) là `undefined`, khiến hàm khởi tạo WASM luôn thực thi lệnh `await import(...)` để tải file `ort-wasm-simd-threaded.mjs`.
  2. Trên giao thức `file://`, trình duyệt Chromium/Edge cấm hoàn toàn dynamic `import()` các file cục bộ, ném ra lỗi `TypeError: Failed to fetch dynamically imported module`.
  3. Khi không dùng `ort.min.mjs` mà dùng bản bundle `ort.wasm.bundle.min.mjs`, factory Emscripten đã được biên dịch nhúng sẵn bên trong (`Xr`), và khi truyền `wasmBinary` từ RAM cùng `numThreads: 1`, ORT dùng thẳng `Xr` mà tuyệt đối không gọi `import()`.
  4. Ngoài ra, Rolldown (Vite 8) tự động biến đổi chuỗi `new URL("ort-wasm-simd-threaded.wasm", import.meta.url)` thành base64 nhúng 4 lần (~70MB thừa). Cần plugin Vite `preventOrtWasmDoubleInline` để giữ kích thước bundle dưới hạn mức 100MB của GitHub.
- **Giải pháp xử lý (Resolution)**:
  1. Trong `vite.config.ts`: Xóa bỏ `conditions: ['onnxruntime-web-use-extern-wasm']`. Thay bằng alias chính xác trỏ đến `node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs`.
  2. Bổ sung plugin `preventOrtWasmDoubleInline` ngăn Vite Rolldown biến đổi `new URL("ort-wasm-simd-threaded.wasm", import.meta.url)` thành base64 dư thừa, giữ bundle ở mức ~72MB (an toàn dưới 100MB của GitHub).
  3. Trong `onnx-ocr.worker.ts`: Đảm bảo khi chạy offline trên `file://`, `ort.env.wasm.wasmBinary` được gán từ `getEmbeddedBuffer()`, `numThreads = 1` và `delete wasmPaths` để Emscripten chạy trực tiếp từ RAM, không gọi `import()`.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Trên `file://`, mọi cơ chế dynamic `import()` của trình duyệt đều bị chặn. Thư viện WebAssembly phức tạp như ONNX Runtime Web bắt buộc phải dùng bản bundle có sẵn Emscripten glue module và khởi tạo bằng `wasmBinary` 1 luồng trong bộ nhớ.

---

### KB-016: Lỗi Web Worker bị chặn trên giao thức file:// khi nạp file chấm công (`Lỗi Web Worker`)
- **Ngày ghi nhận**: 2026-09-11
- **Vị trí**: `src/workers/timesheet-parser.worker.ts`, `src/services/timesheet-parser-service.ts`, `src/services/timesheet-parser-core.ts`, `src/components/layout/Header.tsx`
- **Triệu chứng (Symptom)**:
  - Khi mở `dist/index.html` qua giao thức `file:///C:/Users/.../dist/index.html` và nạp file Excel chấm công (`BẢNG CHẤM CÔNG CHI TIẾT (21.8 - 03.9).xlsx`), hệ thống lập tức thông báo lỗi `Lỗi Web Worker`.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Trên trình duyệt Chromium (Edge / Chrome), khi chạy trên giao thức `file://`, URL có origin là `null`.
  - Khởi tạo Web Worker inline (`new Worker(blobUrl, { type: 'module' })`) bị kiểm tra an ninh Same-Origin nghiêm ngặt, bắn sự kiện `worker.onerror`.
  - Trước đây, `Header.tsx` chỉ lắng nghe `worker.onerror` rồi bắn toast lỗi mà không có bất kỳ cơ chế fallback nào để thực thi trực tiếp trên Main Thread (khác với `ocr-worker-client.ts` đã có `runDirectAsWorkerResult`).
- **Giải pháp xử lý (Resolution)**:
  1. Tách lõi phân tích Excel thành pure in-memory module: `src/services/timesheet-parser-core.ts` (`parseTimesheetInMemory`), chia chunking qua `setTimeout(r, 0)` mỗi 2.000 dòng để giao diện không bị đơ giật.
  2. Tạo service điều phối `src/services/timesheet-parser-service.ts`:
     - Tự động phát hiện `isFileProtocol()`: nếu đang chạy trên `file://`, chuyển thẳng sang `parseTimesheetInMemory` trong main thread, hoàn toàn không tạo Web Worker.
     - Nếu chạy trên HTTP/localhost: khởi tạo Web Worker, nhưng nếu `onerror` kích hoạt, tự động fallback về `parseTimesheetInMemory` trong suốt với người dùng.
  3. Đơn giản hóa `timesheet-parser.worker.ts` chỉ cần gọi lại `parseTimesheetInMemory`.
  4. Cập nhật `Header.tsx` gọi trực tiếp `parseTimesheetFile`, loại bỏ toàn bộ boilerplate worker cũ.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Mọi tác vụ Web Worker trong hệ thống Single-File Offline đều BẮT BUỘC phải có cơ chế In-Memory Main-Thread Fallback khi chạy trên `file://`.

---

### KB-017: Chuyển hoàn toàn Timesheet Parser sang Pure In-Memory, loại bỏ triệt để lỗi Web Worker
- **Ngày ghi nhận**: 2026-09-12
- **Vị trí**: `src/services/timesheet-parser-service.ts`, `src/services/timesheet-parser-core.ts`, `src/components/layout/Header.tsx`
- **Triệu chứng (Symptom)**:
  - Ở môi trường local trên máy Windows (chạy localhost hoặc file://), khi người dùng nạp file Excel chấm công máy, modal thông báo `Đang khởi tạo Web Worker xử lý nền...` và báo lỗi Web Worker (do chính sách CSP hoặc EDR chặn `blob:` URL, hoặc lỗi Structured Clone ArrayBuffer).
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Việc tạo Web Worker inline (`?worker&inline`) từ Blob URL trên trình duyệt Microsoft Edge trong môi trường doanh nghiệp thường bị chính sách an ninh `worker-src 'self'` chặn.
  - Trong khi đó, thuật toán SheetJS (`XLSX.read`) chỉ mất khoảng 300ms để phân tích 20.000 dòng quẹt thẻ, hoàn toàn không cần thiết phải spawn Worker rời.
- **Giải pháp xử lý (Resolution)**:
  1. Chuyển `parseTimesheetFile` trong `timesheet-parser-service.ts` sang chạy trực tiếp `parseTimesheetInMemory` 100% trong main thread, với cơ chế non-blocking chunking (`await new Promise(r => setTimeout(r, 0))`) giữ cho giao diện luôn phản hồi mượt mà.
  2. Bọc `buffer` trong `Uint8Array` chuẩn và bổ sung kiểm tra null an toàn trước khi gọi `XLSX.read`.
  3. Cập nhật text trạng thái trong `Header.tsx` từ `Đang khởi tạo Web Worker xử lý nền...` thành `Đang nạp và phân tích dữ liệu bảng công...`.
  4. Bổ sung bộ test `src/test/timesheet-parser-upload.test.ts` xác thực quy trình nạp tệp Excel hoàn toàn xanh (134/134 tests PASS).
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Đối với các tác vụ xử lý bảng tính dưới 1 giây, ưu tiên tuyệt đối Pure In-Memory với async microtask ticks thay vì Web Worker để đạt độ ổn định 100% trên mọi môi trường bảo mật cao.

---

### KB-018: File .bat UTF-8 có dấu tiếng Việt gây vỡ lệnh cmd.exe + pattern one-click Falcon-safe
- **Ngày ghi nhận**: 2026-09-19
- **Vị trí**: `register-protocol.bat`, `unregister-protocol.bat`, `src/pages/SettingsPage.tsx` (handleLaunchServerProtocol, handleDownloadRegisterBat, handleCopyRegisterCommands, handleOpenRegisterHelp)
- **Triệu chứng (Symptom)**:
  - Chạy `register-protocol.bat` báo hàng loạt `'Thức' is not recognized`, `'SCRIPT_DIR"' is not recognized`, `'BS_PATH"'`, `'cript.exe'`, `'mục:'`, `'Registry'`, `'[THẤT'...` dù lệnh `chcp 65001` đã có trong file.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - File `.bat` được lưu dạng UTF-8 không BOM, chứa ký tự có dấu (Đăng Ký, Giao Thức...). cmd.exe phân tích file .bat theo codepage ANSI hệ thống **trước khi** `chcp 65001` có hiệu lực, nên mỗi ký tự đa byte (2–3 bytes) bị chẻ thành ký tự rác — làm vỡ `set "SCRIPT_DIR"`, `wscript.exe` thành `cript.exe`. `file` báo `UTF-8 text`, trong khi `start-server.bat` (ASCII) chạy bình thường.
- **Giải pháp xử lý (Resolution)**:
  1. Viết lại cả 2 file `.bat` sang **ASCII-only (không dấu) + CRLF**, giữ `chcp 65001` chỉ để hiển thị, mọi `echo`/`set`/`reg` đều ASCII. Verify `all(b<128)` + `CRLF`, `file` báo `ASCII text, with CRLF`.
  2. Giữ nguyên tắc Falcon EDR Safe: chỉ ghi `HKCU\Software\Classes\smarthr`, không Admin/HKLM/Startup/Task Scheduler/PowerShell bypass, `%%1` escape đúng cho registry value.
  3. Frontend: trình duyệt KHÔNG thể tự chạy .bat (sandbox + Falcon chặn auto-execution). Pattern one-click hợp lệ = nút 🚀 thử `smarthr://start` trước → poll `/api/health` 6 lần → nếu fail mở Custom Modal (Zero Native Dialogs) với 3 hành động: Tải file FIXED .bat qua Blob download (nội dung khớp 100% file repo), Copy 5 lệnh HKCU qua clipboard, Hướng dẫn mở thư mục cấp quyền từng bước.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Mọi file `.bat`/`.cmd` chạy trên cmd.exe BẮT BUỘC ASCII-only (không dấu) + CRLF. `chcp 65001` không cứu được lỗi parse. Mọi hứa hẹn "web tự chạy file local" đều sai về mặt sandbox/Falcon — phải thiết kế luồng user-consent 1 lần duy nhất.

---

### KB-019: Dấu & trong đường dẫn OneDrive (Leggett & Platt) cắt lệnh reg + Delayed Expansion
- **Ngày ghi nhận**: 2026-09-19
- **Vị trí**: `register-protocol.bat` dòng `reg add ... /d "wscript.exe ..."` + `REGISTER_BAT_LINES` / `REGISTER_CMDS_TEMPLATE` trong `src/pages/SettingsPage.tsx`
- **Triệu chứng (Symptom)**:
  - Chạy bản bat ASCII-only đã fix KB-018 trên máy có đường dẫn `C:\Users\bbuvqp1\OneDrive - Leggett & Platt, Incorporated\HR-System\`: hiện `The operation completed successfully.` rồi báo `'Platt' is not recognized as an internal or external command` và kết luận sai `[THAT BAI] Co loi khi them khoa Registry.`
- **Nguyên nhân gốc rễ (Root Cause)**:
  - cmd.exe không hiểu `\"` là quote thoát — mỗi dấu `"` đều bật/tắt trạng thái quote. Nên `%VBS_PATH%` trong dòng reg thực chất được expand ở vùng KHÔNG quote, dấu `&` trong `Leggett & Platt` bị xem là ngắt lệnh: nửa sau ` Platt, Incorporated\...` chạy như lệnh mới (lỗi 9009 → errorlevel ≠ 0 → báo THAT BAI giả), nửa đầu ghi vào Registry một giá trị LỆNH CỤT (`wscript.exe "C:\...\OneDrive - Leggett `) không dùng được.
- **Giải pháp xử lý (Resolution)**:
  1. Thêm `setlocal EnableDelayedExpansion` đầu file, đổi dòng reg sang `!VBS_PATH!`: delayed expansion chèn giá trị SAU khi parser tách lệnh nên `&`/space/comma an toàn; reg.exe tự parse theo luật C (`\"` → quote thật) và lưu đúng `wscript.exe "<full path>" "%1"`.
  2. Thêm `reg query "HKCU\Software\Classes\smarthr\shell\open\command" /ve` trong nhánh thành công để in giá trị đã lưu — bằng chứng đối chiếu tại chỗ.
  3. Đồng bộ `REGISTER_BAT_LINES` web (Blob download khớp 100% file repo, đã check bằng node) và `REGISTER_CMDS_TEMPLATE` (thêm `setlocal EnableDelayedExpansion` + `!VBS_PATH!` vì paste vào CMD tương tác cũng dính lỗi `&` y hệt).
  4. Lần chạy lỗi trước đã lưu giá trị cụt — chỉ cần chạy lại bản fix (ghi đè `/f`) là xong, không cần xóa tay.
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Mọi giá trị đường dẫn đưa vào lệnh `reg add /d "...\"...\""` BẮT BUỘC qua Delayed Expansion (`!VAR!`), không bao giờ dùng `%VAR%` trực tiếp — vì `\"` không bảo vệ được `& | < > ^` khỏi parser cmd. Môi trường OneDrive doanh nghiệp (`Leggett & Platt`) gần như chắc chắn chứa `&`.


---

### KB-021: Migrate Dexie → Supabase (mapping, TIME, Flag, RLS, cloud build)
- **Ngày ghi nhận**: 2026-09-21
- **Vị trí**: `src/lib/tables.ts`, toàn bộ `src/pages/*`, `src/services/lan-sync-service.ts`, `src/workers/onnx-ocr.worker.ts`, `vite.config.ts`, `public/_headers`
- **Triệu chứng (Symptom)**:
  - Code cũ dùng field camelCase (`employeeId`, `checkIn`), Postgres dùng snake_case (`employee_id`, `check_in`) + kiểu TIME trả về `'HH:mm:ss'`.
  - Field shadow Flag `isViolationFlag` (Dexie v6) không tồn tại trong Postgres → PostgREST báo `column does not exist` khi upsert.
  - Metadata `_sync`/`_syncNS`/`_syncCL` của luồng JSON-merge cũ cũng không phải cột Postgres.
  - Worker import `../generated/embedded-models` (chỉ sinh ở prebuild) làm `tsc` fail khi bỏ prebuild.
- **Nguyên nhân gốc rễ (Root Cause)**:
  - Không có lớp mapping tập trung; mỗi page tự gọi Dexie API.
  - Single-file build + nhúng base64 là yêu cầu của kỷ nguyên offline `file://`, không còn cần khi có mạng + hosting.
- **Giải pháp xử lý (Resolution)**:
  1. `src/lib/tables.ts` tập trung: `convertRowToCamel` (TIME `HH:mm:ss`→`HH:mm`, alias `created_at`→`timestamp` cho audit), `convertToSnakeShallow` (shallow, object JSONB giữ nguyên, `undefined`→`null`, strip `*_flag`/`fts`/`_*`), `upsertOne/bulkUpsert(500/chunk)/updateByKey/removeByKey/bulkRemove/clearTable/listWhere/deleteWhere/getSetting/putSetting`, `useLiveTable` (select + `postgres_changes` debounce 300ms, channel dùng chung).
  2. Auth: `username@hr.os` tổng hợp cho Supabase Auth; lock/attempt custom bỏ (server-side rate-limit + cờ `is_locked`/`active`); admin đổi pass user khác qua Dashboard.
  3. Worker: bỏ embedded, `MODEL_BASE` từ `VITE_MODEL_BASE_URL` (mặc định `/PaddleOCR-Models`), `wasmPaths` theo origin + Cache Storage; COOP/COEP qua `public/_headers` (Cloudflare Pages) để giữ WASM đa luồng.
  4. Xóa: `src/db`, `db-seeder`, `db-sync`, `json-sync-service`, `lan-push-guard`, `password`, `server.js`, BAT/VBS, `embed-models.mjs`, `viteSingleFile`, `prebuild`; giữ `dexie` cho `ocr-assets-store` (ONNX cache).
- **Bài học kinh nghiệm (Key Takeaway)**:
  - Mọi khác biệt đặt tên/kiểu giữa client và Postgres PHẢI nằm trong 1 module mapper (`tables.ts`), không rải rác từng page.
  - Trước khi upsert, strip mọi field không có trong schema SQL (Flag legacy, `_sync*`) — PostgREST không bỏ qua cột lạ.
  - Verify cuối: `tsc --noEmit` 0 lỗi + `vitest run` 116/116 + `vite build` multi-file.
