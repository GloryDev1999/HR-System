# update-model.md — Fix OCR Model & Worker Loading cho chế độ chạy `file://`

## 0. Bối cảnh & Mục tiêu

**Vấn đề hiện tại**: Ứng dụng SmartHR hiện chạy được khi phục vụ qua HTTP server (`npm run serve`), nhưng **thất bại khi mở trực tiếp bằng double-click** vào `index.html` — cụ thể là Web Worker (ONNX OCR worker, timesheet parser worker, formula worker) và model ONNX/PaddleOCR không load được.

**Nguyên nhân gốc**: Khi mở file qua scheme `file://` (không qua HTTP), trình duyệt Chromium (bao gồm Microsoft Edge) áp dụng các giới hạn bảo mật khác với origin `http://`:
- `new Worker(url, {type: "module"})` bị chặn nếu `url` cần fetch qua network stack — `file://` không cấp quyền đó cho Worker.
- `fetch()` các file rời (`.wasm`, `.onnx`, `.ort`) từ bên trong Worker cũng có nguy cơ bị chặn tương tự.

**Mục tiêu của tài liệu này**: Hướng dẫn từng bước để loại bỏ hoàn toàn việc Worker/model phải "fetch" bất kỳ file rời nào qua network — thay vào đó **nhúng cứng (inline) mọi thứ vào bundle JS** dưới dạng string/Blob/base64, để toàn bộ pipeline hoạt động độc lập với network stack của trình duyệt.

**Môi trường build & chạy thử**:
- Build output đích: `C:\Users\bbuvqp1\OneDrive - Leggett & Platt, Incorporated\HR-System\dist`
- Chạy thử bằng: double-click `C:\Users\bbuvqp1\OneDrive - Leggett & Platt, Incorporated\HR-System\dist\index.html`
- Trình duyệt mục tiêu: **Microsoft Edge** (Chromium-based — mọi hành vi `file://` liên quan Worker/WASM giống hệt Chrome, vì cùng engine).
- Build vẫn chạy trên máy dev có Node.js (build-time), **không phải trên máy end-user** — ràng buộc "không chạy Node" chỉ áp dụng cho máy chạy ứng dụng cuối, không áp dụng cho máy build.

**Phạm vi tài liệu này**: CHỈ xử lý vấn đề Worker/WASM/ONNX model loading dưới `file://`. Không bao gồm phần auth/role/transaction hay cơ chế đồng bộ OneDrive theo folder — hai phần đó nằm trong tài liệu riêng.

---

## 1. Việc cần làm trước tiên: Kiểm chứng giả định (Spike Test)

**Không sửa code chính ngay.** Trước khi refactor toàn bộ, agent cần viết một file test tối giản để xác nhận hướng tiếp cận khả thi trên chính máy/Edge của người dùng.

### Bước 1.1 — Tạo file test độc lập

Tạo file mới `spike-test/worker-wasm-test.html` (không phụ thuộc gì vào phần còn lại của codebase):

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Spike Test</title></head>
<body>
  <div id="log"></div>
  <script>
    const log = (msg) => {
      document.getElementById('log').innerHTML += `<p>${msg}</p>`;
      console.log(msg);
    };

    // TEST 1: Inline Blob Worker (classic, không phải module)
    try {
      const workerCode = `
        self.onmessage = function(e) {
          self.postMessage('Worker nhận được: ' + e.data);
        };
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = (e) => log('✅ TEST 1 PASS - Worker: ' + e.data);
      worker.onerror = (e) => log('❌ TEST 1 FAIL - Worker error: ' + e.message);
      worker.postMessage('hello');
    } catch (err) {
      log('❌ TEST 1 FAIL - Exception: ' + err.message);
    }

    // TEST 2: IndexedDB mở và ghi được
    try {
      const req = indexedDB.open('spike-test-db', 1);
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore('test', { keyPath: 'id' });
      };
      req.onsuccess = (e) => {
        const db = e.target.result;
        const tx = db.transaction('test', 'readwrite');
        tx.objectStore('test').put({ id: 1, value: 'test-data', ts: Date.now() });
        tx.oncomplete = () => log('✅ TEST 2 PASS - IndexedDB ghi thành công');
        tx.onerror = () => log('❌ TEST 2 FAIL - Transaction error');
      };
      req.onerror = () => log('❌ TEST 2 FAIL - Không mở được IndexedDB');
    } catch (err) {
      log('❌ TEST 2 FAIL - Exception: ' + err.message);
    }

    // TEST 3: base64 -> ArrayBuffer (mô phỏng decode model nhúng sẵn)
    try {
      const fakeBase64 = btoa('fake-model-bytes-for-test');
      const binary = atob(fakeBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      log('✅ TEST 3 PASS - base64 decode OK, ' + bytes.length + ' bytes');
    } catch (err) {
      log('❌ TEST 3 FAIL - Exception: ' + err.message);
    }
  </script>
</body>
</html>
```

### Bước 1.2 — Test IndexedDB bền vững qua nhiều lần mở

Sau khi chạy `worker-wasm-test.html` lần đầu (double-click, mở bằng Edge), **đóng hẳn Edge, mở lại file đó lần thứ 2**, thêm đoạn code đọc lại record `id: 1` đã ghi ở lần trước — xác nhận dữ liệu còn tồn tại. Đây là điều kiện tiên quyết bắt buộc: nếu IndexedDB không giữ dữ liệu qua các lần mở lại khi chạy từ `file://`, toàn bộ kiến trúc offline-first của SmartHR không khả thi và cần dừng lại để báo cáo trước khi làm tiếp các bước sau.

### Bước 1.3 — Ghi kết quả

Agent tạo file `spike-test/RESULT.md` ghi lại kết quả 3 test + kết quả persistence test, kèm phiên bản Edge đã test (`edge://version`). Nếu TEST 1 hoặc test persistence FAIL, **dừng lại tại đây**, không thực hiện các bước từ Phần 2 trở đi, báo cáo lại cho người yêu cầu.

Nếu tất cả PASS, tiếp tục Phần 2.

---

## 2. Refactor Worker sang dạng Inline/Blob

### Bước 2.1 — Kiểm kê toàn bộ Worker hiện có

Chạy tìm kiếm trong `src/`:
```
grep -rn "new Worker(" src/
grep -rn "\.worker\.ts" src/
```
Liệt kê đầy đủ danh sách file worker (dự kiến bao gồm `onnx-ocr.worker.ts`, `timesheet-parser.worker.ts`, `formula.worker.ts` theo Plan.md — xác nhận lại tên file thực tế).

### Bước 2.2 — Chuyển cú pháp import Worker sang dạng inline của Vite

Với mỗi chỗ đang khởi tạo worker kiểu:
```ts
const worker = new Worker(new URL('./onnx-ocr.worker.ts', import.meta.url), { type: 'module' });
```

Đổi sang cú pháp Vite worker import với query `?worker&inline`:
```ts
import OcrWorker from './onnx-ocr.worker.ts?worker&inline';
const worker = new OcrWorker();
```

Áp dụng tương tự cho toàn bộ các worker khác đã liệt kê ở Bước 2.1.

**Lưu ý cho agent**: `?worker&inline` là tính năng có sẵn của Vite (không cần cài thêm plugin), sẽ tự động bundle nội dung worker thành base64 data URI ở bước build, loại bỏ hoàn toàn việc fetch file `.js` rời khi khởi tạo Worker. Cần xác nhận phiên bản Vite trong `package.json` hỗ trợ cú pháp này (Vite 4+ trở lên hỗ trợ ổn định).

### Bước 2.3 — Kiểm tra worker không dùng `importScripts()` trỏ ra file ngoài

Grep trong tất cả file `*.worker.ts`:
```
grep -n "importScripts" src/**/*.worker.ts
```
Nếu có, các file được import bằng `importScripts` cũng phải được nhúng cứng theo cách tương tự — không được để worker tự fetch thêm bất kỳ file rời nào khác ở runtime.

---

## 3. Nhúng model ONNX/PaddleOCR làm base64 tại build-time

### Bước 3.1 — Viết script build tiền xử lý

Tạo file `scripts/embed-models.mjs` (chạy trên máy build bằng Node, KHÔNG chạy trên máy end-user):

```js
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MODEL_DIR = 'PaddleOCR-Models'; // điều chỉnh đúng path thực tế trong repo
const OUTPUT_FILE = 'src/generated/embedded-models.ts';

const files = readdirSync(MODEL_DIR).filter(f =>
  f.endsWith('.onnx') || f.endsWith('.ort') || f.endsWith('.wasm') || f === 'latin_dict.txt'
);

let output = '// FILE TỰ ĐỘNG SINH RA BỞI scripts/embed-models.mjs — KHÔNG SỬA TAY\n';
output += 'export const EMBEDDED_MODELS: Record<string, string> = {\n';

for (const file of files) {
  const buffer = readFileSync(join(MODEL_DIR, file));
  const base64 = buffer.toString('base64');
  output += `  "${file}": "${base64}",\n`;
}
output += '};\n';

writeFileSync(OUTPUT_FILE, output);
console.log(`Đã nhúng ${files.length} file vào ${OUTPUT_FILE}`);
```

### Bước 3.2 — Thêm bước này vào pipeline build

Sửa `package.json`, script `build`, thêm bước chạy trước Vite build:
```json
"scripts": {
  "prebuild": "node scripts/embed-models.mjs",
  "build": "vite build"
}
```
(`prebuild` tự động chạy trước `build` theo quy ước npm, không cần gọi thủ công.)

### Bước 3.3 — Sửa code load model trong Worker để dùng bản nhúng thay vì fetch

Tìm đoạn code hiện tại đang load model (dự kiến dạng):
```ts
const session = await ort.InferenceSession.create('/models/paddle-ocr.onnx');
```

Đổi sang:
```ts
import { EMBEDDED_MODELS } from '../generated/embedded-models';

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const modelBuffer = base64ToArrayBuffer(EMBEDDED_MODELS['paddle-ocr.onnx']); // đúng tên file thực tế
const session = await ort.InferenceSession.create(modelBuffer);
```

**Lưu ý cho agent**: `InferenceSession.create()` của `onnxruntime-web` nhận trực tiếp `ArrayBuffer`/`Uint8Array` model, không bắt buộc phải là URL — xác nhận lại chữ ký hàm đúng với phiên bản `onnxruntime-web` khai báo trong `package.json` (kiểm tra `node_modules/onnxruntime-web/types/*.d.ts` nếu cần).

---

## 4. Cấu hình đường dẫn WASM runtime của onnxruntime-web

Đây là phần dễ bị bỏ sót nhất — bản thân thư viện `onnxruntime-web` cần load file `.wasm` riêng để chạy backend WASM (không phải model, mà là runtime thực thi model).

### Bước 4.1 — Xác định phiên bản và API cấu hình wasmPaths

Kiểm tra `node_modules/onnxruntime-web/package.json` lấy version, sau đó mở `node_modules/onnxruntime-web/dist/*.d.ts` tìm định nghĩa `ort.env.wasm` — xác nhận các trường khả dụng (`wasmPaths`, hoặc phiên bản mới hơn có thể hỗ trợ `wasmBinary`/`numThreads` khác nhau tuỳ version). **Không giả định tên field — đọc trực tiếp type definition của bản đang cài.**

### Bước 4.2 — Trỏ wasmPaths sang Blob URL từ base64 đã nhúng

Trong file khởi tạo `onnxruntime-web` (thường ở đầu worker OCR), thêm trước khi gọi `InferenceSession.create`:

```ts
import * as ort from 'onnxruntime-web';
import { EMBEDDED_MODELS } from '../generated/embedded-models';

function base64ToBlobUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

ort.env.wasm.wasmPaths = {
  'ort-wasm-simd.wasm': base64ToBlobUrl(EMBEDDED_MODELS['ort-wasm-simd.wasm'], 'application/wasm'),
  // lặp lại cho từng file .wasm mà onnxruntime-web thực sự yêu cầu —
  // xác nhận danh sách chính xác bằng cách chạy thử ở môi trường HTTP trước
  // (npm run serve), mở tab Network, ghi lại toàn bộ file .wasm được request.
};
```

**Quan trọng**: trước khi viết cứng danh sách file `.wasm` cần nhúng, agent phải chạy `npm run serve` (bản HTTP hiện tại vẫn hoạt động), mở tab Network trong DevTools, lọc theo `.wasm`, ghi lại chính xác tên file được request — vì `onnxruntime-web` có thể yêu cầu nhiều biến thể `.wasm` khác nhau (SIMD/non-SIMD, threaded/non-threaded) tuỳ cấu hình build.

---

## 5. Build và triển khai vào đúng thư mục đích

### Bước 5.1 — Build

```bash
npm run build
```
Xác nhận output đi vào thư mục `dist/` trong repo (kiểm tra `vite.config.ts` mục `build.outDir` nếu khác mặc định).

### Bước 5.2 — Copy/đồng bộ sang đường dẫn OneDrive đích

Nếu repo hiện tại KHÔNG nằm trực tiếp trong OneDrive, thêm bước copy vào cuối script build (PowerShell, hoặc Node `fs.cpSync`):

```json
"scripts": {
  "build": "vite build && node scripts/deploy-to-onedrive.mjs"
}
```

`scripts/deploy-to-onedrive.mjs`:
```js
import { cpSync } from 'fs';
const TARGET = "C:\\Users\\bbuvqp1\\OneDrive - Leggett & Platt, Incorporated\\HR-System\\dist";
cpSync('dist', TARGET, { recursive: true });
console.log('Đã copy build sang', TARGET);
```

Nếu repo đã nằm sẵn trong đúng thư mục OneDrive đó (`vite.config.ts` build thẳng ra `dist` cùng cấp), bỏ qua bước này.

### Bước 5.3 — Kiểm tra output không còn tham chiếu file rời

Trước khi test thủ công, grep trong `dist/index.html` và mọi file `.js` sinh ra:
```
grep -rn "\.onnx\|\.ort\|\.wasm" dist/*.js dist/index.html
```
Kết quả mong đợi: **không còn dòng nào** trỏ đến các file này dưới dạng đường dẫn tương đối (chỉ còn xuất hiện trong chuỗi base64 đã nhúng hoặc tên field JS, không phải như một URL fetch).

---

## 6. Kiểm thử thủ công cuối cùng (Edge, double-click)

Thực hiện đúng tuần tự sau, không bỏ bước:

1. Đóng **hoàn toàn** mọi cửa sổ Edge đang mở (kể cả chạy nền).
2. Double-click `C:\Users\bbuvqp1\OneDrive - Leggett & Platt, Incorporated\HR-System\dist\index.html`.
3. Nhấn `F12` mở DevTools ngay khi trang vừa load — kiểm tra tab Console: không có lỗi màu đỏ liên quan `Worker`, `CORS`, `Failed to fetch`, `SecurityError`.
4. Thử chức năng OCR với 1 ảnh chấm công mẫu — xác nhận có kết quả trả về, không bị treo/timeout.
5. Đóng hẳn Edge, mở lại file `index.html` lần 2 — xác nhận dữ liệu đã nhập ở bước 4 (nếu có lưu) vẫn còn trong app.
6. Ghi lại kết quả (pass/fail từng mục) vào cuối file `spike-test/RESULT.md` đã tạo ở Phần 1.

---

## 7. Nếu vẫn thất bại — phương án dự phòng

Nếu sau khi làm hết các bước trên mà Worker/WASM vẫn không chạy được dưới `file://` (một số phiên bản Edge có thể còn giới hạn chặt hơn dự kiến), agent cần báo cáo lại cụ thể lỗi Console thu được, **không tự ý đoán thêm cách khác và sửa lan man** — đây là điểm cần con người quyết định hướng tiếp theo (ví dụ: chấp nhận bỏ tính năng OCR khi chạy `file://`, chỉ bật khi phục vụ qua IIS; hoặc chuyển hẳn sang giải pháp IIS đã bàn trước đó).

---

## Checklist tổng hợp cho agent

- [ ] Spike test (Phần 1) pass — đặc biệt IndexedDB persistence qua nhiều lần mở
- [ ] Toàn bộ Worker chuyển sang `?worker&inline`, không còn `{type: "module"}` fetch qua URL rời
- [ ] Không còn `importScripts` trỏ file ngoài trong bất kỳ worker nào
- [ ] Model ONNX/PaddleOCR nhúng base64 qua `scripts/embed-models.mjs`, chạy tự động trong `prebuild`
- [ ] `InferenceSession.create()` nhận `ArrayBuffer` từ base64 đã nhúng, không còn gọi bằng URL string
- [ ] `ort.env.wasm.wasmPaths` trỏ Blob URL từ base64 nhúng, danh sách file `.wasm` đã xác nhận đúng qua tab Network khi chạy bản HTTP
- [ ] `npm run build` chạy thành công, output vào đúng `dist/`
- [ ] Grep xác nhận `dist/` không còn tham chiếu `.onnx/.ort/.wasm` dạng đường dẫn fetch
- [ ] Test thủ công theo đúng 6 bước ở Phần 6, ghi kết quả vào `spike-test/RESULT.md`
