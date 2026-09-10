/**
 * scripts/embed-models.mjs — Nhúng model PaddleOCR + WASM runtime thành base64
 * tại build-time (chạy trên máy build bằng Node, KHÔNG chạy trên máy end-user).
 *
 * Theo update-model.md §3.1, với các hiệu chỉnh dựa trên chứng cứ trong repo:
 *  1. Spec ghi `readdirSync(MODEL_DIR)` phẳng — thực tế model nằm ở subdirs
 *     `onnx/`, `ort/`, `dictionaries/` nên script dùng DANH SÁCH FILE EXPLICIT.
 *  2. `ch_PP-OCRv4_rec.onnx` (11MB) KHÔNG được code nào load (worker + direct
 *     engine chỉ dùng `latin_PP-OCRv3_rec.onnx`) nên KHÔNG nhúng để tiết kiệm
 *     ~15MB base64. Muốn nhúng thêm thì thêm vào REQUIRED_FILES.
 *  3. Output có `// @ts-nocheck` để `tsc` không type-check string 35MB.
 *  4. File output KHÔNG commit (xem .gitignore) — luôn sinh lại ở `prebuild`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_FILE = join(root, 'src', 'generated', 'embedded-models.ts');

// Danh sách file THẬT SỰ được pipeline load (đối chiếu src/workers/onnx-ocr.worker.ts
// ensureBundle + src/services/ocr-engine-direct.ts ensureBundle + wasmPaths).
const REQUIRED_FILES = [
  'PaddleOCR-Models/onnx/ch_PP-OCRv4_det_infer.onnx', // det 4.6MB
  'PaddleOCR-Models/onnx/latin_PP-OCRv3_rec.onnx', // rec latin/vi 8.6MB
  'PaddleOCR-Models/ort/ort-wasm-simd-threaded.wasm', // ORT wasm runtime 13MB
  'PaddleOCR-Models/ort/ort-wasm-simd-threaded.mjs', // ORT glue 24KB (dự phòng)
  'PaddleOCR-Models/dictionaries/latin_dict.txt', // CTC dict chính
  'PaddleOCR-Models/dictionaries/vi_dict.txt', // HR RAG bổ sung
];

// KHÔNG nhúng (có chủ đích, tiết kiệm ~15MB base64):
// - PaddleOCR-Models/onnx/ch_PP-OCRv4_rec.onnx: không có code nào load.

let output =
  '// FILE TỰ ĐỘNG SINH RA BỞI scripts/embed-models.mjs — KHÔNG SỬA TAY\n' +
  '// @ts-nocheck\n' +
  'export const EMBEDDED_MODELS: Record<string, string> = {\n';

let totalBytes = 0;
const fileBytes = {};
for (const rel of REQUIRED_FILES) {
  const abs = join(root, rel);
  let buffer;
  try {
    buffer = readFileSync(abs);
  } catch {
    console.error(`[embed-models] THIẾU FILE BẮT BUỘC: ${rel} (đường dẫn tuyệt đối ${abs})`);
    process.exit(1);
  }
  if (buffer.length === 0) {
    console.error(`[embed-models] FILE RỖNG: ${rel}`);
    process.exit(1);
  }
  totalBytes += buffer.length;
  fileBytes[rel] = buffer.length;
  output += `  ${JSON.stringify(rel)}: ${JSON.stringify(buffer.toString('base64'))},\n`;
  console.log(`[embed-models] ${rel} — ${(buffer.length / 1048576).toFixed(2)} MB`);
}
output += '};\n';

mkdirSync(join(root, 'src', 'generated'), { recursive: true });
writeFileSync(OUTPUT_FILE, output);

// Manifest NHỎ (vài trăm bytes) cho main thread đọc mà không phải bundle 35MB.
// onnx-model-checker.ts import file này để báo cáo đúng nguồn model.
const dictInfo = {};
for (const rel of ['PaddleOCR-Models/dictionaries/latin_dict.txt', 'PaddleOCR-Models/dictionaries/vi_dict.txt']) {
  try {
    const text = readFileSync(join(root, rel), 'utf-8');
    const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    const charset = new Set(lines.join('').split(''));
    dictInfo[rel] = {
      lines: lines.length,
      hasVietnamese: ['ệ', 'ơ', 'ư', 'đ', 'ậ'].every(c => charset.has(c)),
      hasVietnamese8: ['ệ', 'ơ', 'ư', 'đ', 'ậ', 'ă', 'ị', 'ỹ'].every(c => charset.has(c)),
    };
  } catch {
    dictInfo[rel] = { lines: 0, hasVietnamese: false };
  }
}
const manifestTs =
  '// FILE TỰ ĐỘNG SINH RA BỞI scripts/embed-models.mjs — KHÔNG SỬA TAY\n' +
  'export const EMBEDDED_AVAILABLE = true;\n' +
  `export const EMBEDDED_MANIFEST = ${JSON.stringify(
    { files: REQUIRED_FILES, fileBytes, totalBytes, dictInfo, generatedAt: new Date().toISOString() },
    null,
    2,
  )};\n`;
writeFileSync(join(root, 'src', 'generated', 'embedded-manifest.ts'), manifestTs);
console.log(
  `[embed-models] Đã nhúng ${REQUIRED_FILES.length} file (${(totalBytes / 1048576).toFixed(1)} MB -> base64 ~${(totalBytes * 4 / 3 / 1048576).toFixed(1)} MB) vào src/generated/embedded-models.ts`,
);
