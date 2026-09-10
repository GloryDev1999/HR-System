# Spike Test RESULT — Worker/WASM `file://` trên Microsoft Edge

> File test: `spike-test/worker-wasm-test.html` (đúng spec update-model.md §1.1, đã bổ sung TEST 2b persistence trong cùng file).
> Cách chạy: đóng hẳn Edge -> double-click `spike-test/worker-wasm-test.html` (lần 1) -> ghi kết quả -> đóng hẳn Edge -> mở lại (lần 2) để kiểm tra TEST 2b.

## 1. Kết quả lần mở 1 (điền sau khi test trên máy Windows + Edge)

- [ ] TEST 1 Blob Worker classic: PASS / FAIL — log: ___
- [ ] TEST 2 IndexedDB ghi: PASS / FAIL — log: ___
- [ ] TEST 2b persistence (lần 1, dự kiến INFO chưa có dữ liệu cũ): ___
- [ ] TEST 3 base64 decode: PASS / FAIL — log: ___

## 2. Kết quả lần mở 2 (đóng hẳn Edge rồi mở lại)

- [ ] TEST 2b persistence: PASS (thấy `dữ liệu lần mở trước còn tồn tại`) / FAIL — log: ___

## 3. Môi trường

- Edge version (`edge://version`): ___
- Windows version: ___
- Đường dẫn file khi test: ___

## 4. Kết luận (theo update-model.md §1.3)

- Nếu TEST 1 hoặc TEST 2b FAIL -> DỪNG, không làm Phần 2+, báo cáo lại.
- Nếu tất cả PASS -> tiếp tục Phần 2 (Refactor Worker inline + embed model).

## 5. Kiểm chứng container-side (agent, 2026-09-10, không thay thế test Edge)

- File test đã tạo đúng spec, thêm TEST 2b đọc-trước-ghi-sau trong cùng file để lần mở 2 xác nhận được persistence mà không cần sửa code giữa 2 lần mở.
- Kiểm kê Worker thực tế trong `src/` (khác dự kiến trong tài liệu):
  - `new Worker(` chỉ xuất hiện ở 2 nơi: `src/components/layout/Header.tsx:99` (timesheet-parser) và `src/services/ocr-worker-client.ts:46` (onnx-ocr). `src/workers/formula-engine.worker.ts` tồn tại nhưng KHÔNG được khởi tạo ở đâu (orphan).
  - `importScripts`: không có trong bất kỳ `*.worker.ts` nào.
  - Vite `8.2.2` hỗ trợ `?worker&inline` ổn định (Vite 4+).
  - Model thật cần nhúng cho pipeline OCR đang dùng: `ch_PP-OCRv4_det_infer.onnx` (4.6MB) + `latin_PP-OCRv3_rec.onnx` (8.6MB) + `ort-wasm-simd-threaded.wasm` (13MB) + `latin_dict.txt` (468B) + `vi_dict.txt` (663B). Tổng ~26MB -> base64 ~35MB. `index.html` hiện 2.2MB sẽ thành ~37MB sau khi nhúng (cảnh báo parse chậm lần đầu + OneDrive sync nặng, đã ghi trong báo cáo).

## 6. Lỗi timesheet-parser.worker `file://` origin 'null' (2026-09-10, báo bởi user)

- Triệu chứng: nạp dữ liệu chấm công ở local báo `Failed to construct 'Worker': Script at 'file:///.../dist/timesheet-parser.worker-DKe9plTH.js' cannot be accessed from origin 'null'`.
- Nguyên nhân gốc: `dist/` đang mở là BẢN BUILD CŨ (còn file worker rời `timesheet-parser.worker-DKe9plTH.js` + `onnx-ocr.worker-CazCIZxJ.js`). Chromium chặn mọi Worker fetch file rời trên `file://` (origin `null`) — đúng giả định update-model.md §0.
- Fix đã áp dụng ( Petro đúng spec §2.2): cả 2 điểm `new Worker(new URL(...))` chuyển sang `?worker&inline` (`Header.tsx:25,100`, `ocr-worker-client.ts:17,51`). Build mới `dist/index.html` 38MB, KHÔNG còn file `*.worker-*.js` nào (xác nhận bằng `ls dist/`).
- Quy tắc: sau mỗi lần sửa code PHẢI `npm run build` lại trên máy dev rồi mới copy `dist/index.html` mới sang OneDrive và double-click lại. Mở nhầm `index.html` cũ là gặp lại lỗi này.
