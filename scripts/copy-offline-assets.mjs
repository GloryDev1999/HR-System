/**
 * Copy tài nguyên PaddleOCR-Models cạnh dist/index.html sau khi vite build
 * để Cloudflare Pages serve cùng host (worker fetch + Cache Storage):
 *  - PaddleOCR-Models/onnx        : model detection + recognition (~14MB)
 *  - PaddleOCR-Models/dictionaries: latin_dict.txt (CTC decode tiếng Việt)
 *  - PaddleOCR-Models/ort         : ONNX Runtime Web WASM runtime (~13MB)
 * (public/* đã được vite tự copy: fonts, image.png, Leggett.jpg, _headers)
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

console.log('[offline-assets] Hoàn tất - model sẵn sàng serve cùng dist.');
