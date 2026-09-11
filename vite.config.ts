import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';

// Ngăn Vite asset-import-meta-url tự động nhúng đúp 4 lần ort-wasm-simd-threaded.wasm (~70MB thừa)
function preventOrtWasmDoubleInline() {
  return {
    name: 'prevent-ort-wasm-double-inline',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (id.includes('ort.wasm.bundle') || id.includes('onnxruntime-web')) {
        return {
          code: code.replaceAll('"ort-wasm-simd-threaded.wasm"', '["ort-wasm-simd-threaded", "wasm"].join(".")'),
          map: null
        };
      }
    }
  };
}

export default defineConfig({
  plugins: [
    preventOrtWasmDoubleInline(),
    react(),
    tailwindcss(),
    viteSingleFile()
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
    format: 'iife'
  },
  // Offline file:// (OneDrive HR-System): mọi asset phải tương đối để mở
  // trực tiếp dist/index.html vẫn đúng đường dẫn. Không dùng '/'.
  base: './',
  build: {
    target: 'esnext',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false
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
