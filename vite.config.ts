import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Cloud-only (Cloudflare Pages): build multi-file thường, KHÔNG singlefile.
// Model ONNX + WASM serve rời từ dist/PaddleOCR-Models (copy-offline-assets).
// COOP/COEP gắn ở public/_headers để bật SharedArrayBuffer (WASM đa luồng).

// (Đã xóa clusterSignalingPlugin Star-Topology RTC ngày 2026-09-16;
// đã xóa viteSingleFile + nhúng base64 model ngày 2026-09-21: cloud-only.)

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}']
  },
  resolve: {
    alias: [
      { find: /^onnxruntime-web$/, replacement: path.resolve(import.meta.dirname, './node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs') },
      { find: '@', replacement: path.resolve(import.meta.dirname, './src') }
    ]
  },
  worker: {
    format: 'es'
  },
  // Cloudflare Pages: base tương đối để sống cả custom domain lẫn sub-path.
  base: './',
  build: {
    target: 'esnext',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 20000000
  },
  server: {
    port: 3000,
    host: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    }
  },
  preview: {
    port: 3000,
    host: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    }
  }
});
