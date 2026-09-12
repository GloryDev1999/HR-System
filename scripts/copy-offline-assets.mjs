/**
 * Copy tài nguyên OFFLINE cần thiết cạnh dist/index.html sau khi vite build:
 *  - PaddleOCR-Models/onnx        : model detection + recognition (~14MB)
 *  - PaddleOCR-Models/dictionaries: latin_dict.txt (CTC decode tiếng Việt)
 *  - PaddleOCR-Models/ort         : ONNX Runtime Web WASM runtime (~13MB)
 * (public/* đã được vite tự copy: fonts, image.png, Leggett.jpg)
 */
import { cpSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const src = join(root, 'PaddleOCR-Models');

const targets = ['onnx', 'dictionaries', 'ort'];

if (!existsSync(src)) {
  console.error(`[offline-assets] Không tìm thấy ${src} - bỏ qua copy.`);
  process.exit(1);
}
mkdirSync(dist, { recursive: true });

for (const t of targets) {
  const from = join(src, t);
  if (!existsSync(from)) {
    console.warn(`[offline-assets] Cảnh báo: thiếu ${from}`);
    continue;
  }
  cpSync(from, join(dist, 'PaddleOCR-Models', t), { recursive: true });
  console.log(`[offline-assets] Đã copy PaddleOCR-Models/${t} -> dist/`);
}

const batFile = join(root, 'CHAY_SMART_HR.bat');
if (existsSync(batFile)) {
  cpSync(batFile, join(dist, 'CHAY_SMART_HR.bat'));
  console.log('[offline-assets] Đã copy CHAY_SMART_HR.bat -> dist/');
}

console.log('[offline-assets] Hoàn tất - bản build chạy offline đầy đủ.');
