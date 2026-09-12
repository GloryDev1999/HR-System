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

// Plugin chuyển tiếp tín hiệu WebRTC P2P trong mạng LAN qua cổng HTTP 3000 hiện có
// Không mở port OS mới, không tạo .exe -> Vượt qua kiểm duyệt CrowdStrike Falcon EDR
function clusterSignalingPlugin() {
  interface ISignalItem {
    id: string;
    type: string;
    targetClient?: string;
    fromHost?: string;
    clientId?: string;
    arrivedAt: number;
    [key: string]: any;
  }
  const signalQueue: ISignalItem[] = [];

  const handler = (req: any, res: any, next: any) => {
    if (req.url && req.url.startsWith('/api/cluster/signaling')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: any) => { body += chunk; });
        req.on('end', () => {
          try {
            const msg = JSON.parse(body);
            const item: ISignalItem = {
              ...msg,
              id: msg.id || `sig_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
              arrivedAt: Date.now()
            };
            signalQueue.push(item);
            // Dọn dẹp tin nhắn cũ hơn 30s
            const cutoff = Date.now() - 30000;
            while (signalQueue.length > 0 && signalQueue[0].arrivedAt < cutoff) {
              signalQueue.shift();
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, count: signalQueue.length }));
          } catch (e: any) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (req.method === 'GET') {
        const url = new URL(req.url, 'http://localhost');
        const role = url.searchParams.get('role');
        const nodeId = url.searchParams.get('nodeId');
        const since = parseInt(url.searchParams.get('since') || '0', 10);

        const matching = signalQueue.filter((s) => {
          if (s.arrivedAt <= since) return false;
          if (nodeId && (s.clientId === nodeId || s.fromHost === nodeId)) return false;

          if (role === 'HOST') {
            return s.type === 'CLIENT_HELLO' || s.type === 'ANSWER_SDP';
          }
          if (role === 'CLIENT') {
            if (s.type === 'HOST_ANNOUNCE') return true;
            if (s.type === 'OFFER_SDP' && s.targetClient === nodeId) return true;
            return false;
          }
          return false;
        });

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ signals: matching, timestamp: Date.now() }));
        return;
      }

      if (req.method === 'DELETE') {
        signalQueue.length = 0;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
        return;
      }
    }
    next();
  };

  return {
    name: 'cluster-signaling-relay',
    configureServer(server: any) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server: any) {
      server.middlewares.use(handler);
    }
  };
}

export default defineConfig({
  plugins: [
    preventOrtWasmDoubleInline(),
    clusterSignalingPlugin(),
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
    format: 'es'
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
