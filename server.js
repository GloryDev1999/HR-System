/**
 * SmartHR Enterprise - Lightweight Standalone LAN Server & Realtime Sync Hub
 * Tối ưu hóa cho môi trường Falcon EDR & Node.js Portable
 * 
 * Đặc tính kỹ thuật:
 * 1. ZERO DEPENDENCY: 100% thư viện chuẩn Node.js (http, fs, path, os, zlib, url).
 * 2. PORTABLE READY: Chạy trực tiếp qua `node server.js` với node.exe portable không cần setup.
 * 3. REALTIME SSE ENGINE: Kênh Server-Sent Events (/api/realtime) thông báo tức thì ai đang online.
 * 4. LAN DATA SYNC HUB: Tự động truyền nhận delta mutation (/api/sync/mutate & /api/sync/pull) giữa các máy trong LAN.
 * 5. FALCON EDR COMPLIANT:
 *    - 0 child process spawning (tránh heuristic Living-off-the-Land).
 *    - Streaming I/O cho file lớn (dist/index.html 75MB), RAM máy chủ < 15MB.
 *    - Gzip/Deflate on-the-fly nén bundle 75MB -> ~15MB truyền LAN siêu tốc.
 *    - Chống Path Traversal (bảo vệ thư mục gốc).
 *    - COOP & COEP Headers chuẩn bắt buộc cho ONNX Runtime WASM SIMD (SharedArrayBuffer).
 *    - Cache-Control & ETag 304 Not Modified giúp F5 tức thì.
 *    - SPA Fallback routing cho React Router.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Xác định thư mục tài nguyên tĩnh (dist/ -> public/ -> root)
function resolveStaticRoot() {
  const candidates = [
    path.join(__dirname, 'dist'),
    path.join(__dirname, 'public'),
    __dirname
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir) && fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  return path.join(__dirname, 'dist');
}

const STATIC_ROOT = resolveStaticRoot();
const DATA_DIR = path.join(__dirname, 'data');
const MASTER_STORE_FILE = path.join(DATA_DIR, 'lan_master_store.json');

// Đảm bảo thư mục lưu dữ liệu tồn tại
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    // Ignore
  }
}

// 2. Parse Port từ tham số dòng lệnh hoặc biến môi trường
function getPort() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      const p = parseInt(args[i + 1], 10);
      if (!isNaN(p)) return p;
    }
    const directPort = parseInt(args[i], 10);
    if (!isNaN(directPort)) return directPort;
  }
  return parseInt(process.env.PORT || '4173', 10);
}

const PORT = getPort();
const HOST = '0.0.0.0'; // Lắng nghe trên tất cả card mạng LAN

// 3. MIME types
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

// 4. Quản lý Realtime SSE & Khách kết nối
const clientsMap = new Map(); // ip -> client stats
const onlineUsersMap = new Map(); // username -> user presence object
const sseSubscribers = new Set(); // Set of http.ServerResponse
const syncMutationJournal = []; // Lịch sử thay đổi dữ liệu gần nhất (tối đa 2000 bản ghi)
const MAX_JOURNAL_SIZE = 2000;

// Nạp journal từ file nếu có
try {
  if (fs.existsSync(MASTER_STORE_FILE)) {
    const raw = fs.readFileSync(MASTER_STORE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.journal)) {
      syncMutationJournal.push(...parsed.journal.slice(-MAX_JOURNAL_SIZE));
    }
  }
} catch (err) {
  console.warn('[SYNC STORE] Chưa có file master store cũ, tạo mới khi có mutation.');
}

// Lưu journal xuống đĩa (Debounced 1s)
let saveStoreTimeout = null;
function persistMasterStore() {
  if (saveStoreTimeout) clearTimeout(saveStoreTimeout);
  saveStoreTimeout = setTimeout(() => {
    try {
      const dataToSave = {
        updatedAt: new Date().toISOString(),
        totalMutations: syncMutationJournal.length,
        journal: syncMutationJournal.slice(-MAX_JOURNAL_SIZE)
      };
      fs.writeFileSync(MASTER_STORE_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
    } catch (e) {
      console.error('[SYNC STORE ERROR]', e.message);
    }
  }, 1000);
}

function parseUserAgent(ua = '') {
  let browser = 'Trình duyệt Web';
  if (ua.includes('Edg/')) browser = 'Microsoft Edge';
  else if (ua.includes('Chrome/')) browser = 'Google Chrome';
  else if (ua.includes('Firefox/')) browser = 'Mozilla Firefox';
  else if (ua.includes('Safari/') && !ua.includes('Chrome/')) browser = 'Apple Safari';

  let osName = 'Thiết bị';
  if (ua.includes('Windows NT 10.0')) osName = 'Windows 10/11';
  else if (ua.includes('Windows')) osName = 'Windows';
  else if (ua.includes('Android')) osName = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) osName = 'iOS';
  else if (ua.includes('Mac OS')) osName = 'macOS';
  else if (ua.includes('Linux')) osName = 'Linux';

  return `${browser} (${osName})`;
}

function getClientIp(req) {
  const raw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.connection?.remoteAddress || '';
  const firstIp = String(raw).split(',')[0].trim();
  return firstIp.replace(/^.*:/, '') || firstIp;
}

function isLocalhost(ip) {
  return ip === '127.0.0.1' || ip === 'localhost' || ip === '::1' || ip === '';
}

function formatTime(date = new Date()) {
  return date.toTimeString().split(' ')[0];
}

// Phát thông điệp SSE tới tất cả máy đang kết nối
function broadcastSSE(type, payload, excludeClient = null) {
  const message = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseSubscribers) {
    if (client !== excludeClient && !client.writableEnded) {
      try {
        client.write(message);
      } catch (err) {
        sseSubscribers.delete(client);
      }
    }
  }
}

// Dọn dẹp user offline quá 30 giây
function cleanupInactiveUsers() {
  const now = Date.now();
  let changed = false;
  for (const [username, user] of onlineUsersMap.entries()) {
    if (now - user.lastActive > 30000) {
      onlineUsersMap.delete(username);
      changed = true;
      console.log(`⚪ [USER OFFLINE] ${user.displayName || username} (${username}) vừa rời hệ thống.`);
    }
  }
  if (changed) {
    broadcastSSE('presence', Array.from(onlineUsersMap.values()));
  }
}
setInterval(cleanupInactiveUsers, 10000);

// Gửi SSE Keep-Alive comment mỗi 15 giây
setInterval(() => {
  for (const client of sseSubscribers) {
    if (!client.writableEnded) {
      try {
        client.write(': ping\n\n');
      } catch (e) {
        sseSubscribers.delete(client);
      }
    }
  }
}, 15000);

// Theo dõi lượt truy cập web thông thường
function trackClientConnection(req, requestPath) {
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || 'Không rõ';
  const now = new Date();
  const isLan = !isLocalhost(ip);
  const deviceLabel = parseUserAgent(ua);

  const existing = clientsMap.get(ip);
  const isNewClient = !existing;

  if (isNewClient) {
    clientsMap.set(ip, {
      ip,
      isLan,
      deviceLabel,
      userAgent: ua,
      firstSeen: now,
      lastSeen: now,
      totalRequests: 1,
      lastPath: requestPath
    });

    if (isLan) {
      console.log('\n------------------------------------------------------------');
      console.log(`🟢 [MÁY KHÁCH LAN KẾT NỐI] ${formatTime(now)}`);
      console.log(`   📍 Địa chỉ IP:   ${ip}`);
      console.log(`   💻 Thiết bị:      ${deviceLabel}`);
      console.log(`   📄 Trang tải:     ${requestPath}`);
      console.log(`   👥 Tổng máy LAN:  ${Array.from(clientsMap.values()).filter(c => c.isLan).length} máy đang kết nối`);
      console.log('------------------------------------------------------------\n');
    }
  } else {
    existing.lastSeen = now;
    existing.totalRequests += 1;
    existing.lastPath = requestPath;
  }
}

// 5. Lấy danh sách IP mạng LAN nội bộ
function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({ name, address: net.address });
      }
    }
  }
  return addresses;
}

function generateETag(stat) {
  return `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
}

// Đọc body JSON an toàn
function readJsonBody(req, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 50 * 1024 * 1024) { // Giới hạn 50MB
      req.destroy();
    }
  });
  req.on('end', () => {
    try {
      const data = body ? JSON.parse(body) : {};
      callback(null, data);
    } catch (err) {
      callback(err, null);
    }
  });
}

// 6. Request Handler chính
const server = http.createServer((req, res) => {
  // CORS Headers chuẩn cho mạng LAN
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match, If-Modified-Since');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let requestPath = '';
  try {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    requestPath = decodeURIComponent(parsedUrl.pathname);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  trackClientConnection(req, requestPath);

  // =========================================================================
  // API 1: Kênh Realtime Server-Sent Events (SSE) - /api/realtime
  // =========================================================================
  if (requestPath === '/api/realtime' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    });

    sseSubscribers.add(res);

    // Gửi ngay danh sách user đang online hiện tại
    const initialPresence = Array.from(onlineUsersMap.values());
    res.write(`event: presence\ndata: ${JSON.stringify(initialPresence)}\n\n`);

    req.on('close', () => {
      sseSubscribers.delete(res);
    });
    return;
  }

  // =========================================================================
  // API 2: Gửi Heartbeat / Khai báo Người dùng Online - /api/presence/heartbeat
  // =========================================================================
  if (requestPath === '/api/presence/heartbeat' && req.method === 'POST') {
    readJsonBody(req, (err, data) => {
      if (err || !data.username) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid payload' }));
        return;
      }

      const clientIp = getClientIp(req);
      const isNew = !onlineUsersMap.has(data.username);

      const userRecord = {
        username: data.username,
        displayName: data.displayName || data.username,
        role: data.role || 'User',
        currentTab: data.currentTab || 'Bảng điều khiển',
        ip: clientIp,
        deviceLabel: parseUserAgent(req.headers['user-agent'] || ''),
        lastActive: Date.now(),
        color: data.color || ''
      };

      onlineUsersMap.set(data.username, userRecord);

      if (isNew) {
        console.log(`🟢 [USER ONLINE] ${userRecord.displayName} (${userRecord.role}) vừa đăng nhập từ ${clientIp}`);
      }

      // Phát sự kiện presence cho tất cả máy đang nghe SSE
      broadcastSSE('presence', Array.from(onlineUsersMap.values()));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', onlineCount: onlineUsersMap.size }));
    });
    return;
  }

  // =========================================================================
  // API 3: Đẩy Thay Đổi Dữ Liệu Realtime (Sync Mutate) - /api/sync/mutate
  // =========================================================================
  if (requestPath === '/api/sync/mutate' && req.method === 'POST') {
    readJsonBody(req, (err, mutation) => {
      if (err || !mutation.table || !mutation.action) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid mutation payload' }));
        return;
      }

      const clientIp = getClientIp(req);
      const enrichedMutation = {
        id: `mut_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        table: mutation.table,
        action: mutation.action, // 'put' | 'delete' | 'bulkPut'
        record: mutation.record,
        key: mutation.key,
        by: mutation.by || 'unknown',
        ip: clientIp,
        timestamp: Date.now()
      };

      // Ghi nhận vào Journal RAM + lên lịch ghi đĩa
      syncMutationJournal.push(enrichedMutation);
      if (syncMutationJournal.length > MAX_JOURNAL_SIZE) {
        syncMutationJournal.shift();
      }
      persistMasterStore();

      console.log(`🔄 [LAN SYNC] ${enrichedMutation.by} vừa ${enrichedMutation.action} bảng [${enrichedMutation.table}] từ IP ${clientIp}`);

      // Broadcast sự kiện mutation cho tất cả các máy khách khác
      broadcastSSE('mutation', enrichedMutation, null);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mutationId: enrichedMutation.id }));
    });
    return;
  }

  // =========================================================================
  // API 4: Kéo Dữ Liệu Bù (Catch-up Pull Sync) - /api/sync/pull
  // =========================================================================
  if (requestPath === '/api/sync/pull' && req.method === 'GET') {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const since = parseInt(parsedUrl.searchParams.get('since') || '0', 10);

    const delta = syncMutationJournal.filter(m => m.timestamp > since);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      since,
      count: delta.length,
      mutations: delta,
      serverTime: Date.now()
    }));
    return;
  }

  // =========================================================================
  // API 5: Kiểm Tra Trạng Thái Máy Chủ - /api/health
  // =========================================================================
  if (requestPath === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      port: PORT,
      lanAddresses: getLanAddresses(),
      onlineUsers: Array.from(onlineUsersMap.values()),
      totalMutations: syncMutationJournal.length,
      serverTime: Date.now()
    }));
    return;
  }

  // Trang chẩn đoán giao diện web /status
  if (requestPath === '/status' || requestPath === '/lan') {
    serveStatusPage(req, res);
    return;
  }

  // =========================================================================
  // Phục vụ tài nguyên tĩnh & SPA (dist/index.html, models, assets)
  // =========================================================================
  let safeRelativePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, '');
  if (safeRelativePath === '/' || safeRelativePath === '\\' || safeRelativePath === '.') {
    safeRelativePath = 'index.html';
  }

  let filePath = path.join(STATIC_ROOT, safeRelativePath);
  const normalizedRoot = path.resolve(STATIC_ROOT);
  const normalizedPath = path.resolve(filePath);

  if (!normalizedPath.startsWith(normalizedRoot)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: Directory Traversal Protected');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      fs.stat(filePath, (indexErr, indexStats) => {
        if (indexErr || !indexStats.isFile()) {
          serveFallbackSpa(req, res);
        } else {
          serveFile(req, res, filePath, indexStats);
        }
      });
      return;
    }

    if (err || !stats.isFile()) {
      const ext = path.extname(filePath);
      if (!ext || ext === '.html') {
        serveFallbackSpa(req, res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      }
      return;
    }

    serveFile(req, res, filePath, stats);
  });
});

// Trang chẩn đoán HTML
function serveStatusPage(req, res) {
  const lanAddresses = getLanAddresses();
  const allUsers = Array.from(onlineUsersMap.values());
  const allClients = Array.from(clientsMap.values());

  const userRowsHtml = allUsers.map((u, idx) => `
    <tr style="border-bottom: 1px solid #e2e8f0; background: #f0fdf4;">
      <td style="padding: 12px 16px; font-weight: 600;">${idx + 1}</td>
      <td style="padding: 12px 16px; font-weight: 700; color: #166534;">${u.displayName} (${u.username})</td>
      <td style="padding: 12px 16px;"><span style="background: #dbeafe; color: #1e40af; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 700;">${u.role}</span></td>
      <td style="padding: 12px 16px; font-family: monospace; font-size: 13px;">${u.ip}</td>
      <td style="padding: 12px 16px; color: #64748b;">${u.currentTab || 'Bảng điều khiển'}</td>
      <td style="padding: 12px 16px; color: #15803d; font-weight: 600;">🟢 Online</td>
    </tr>
  `).join('') || `<tr><td colspan="6" style="padding: 24px; text-align: center; color: #94a3b8; font-style: italic;">Chưa có tài khoản đăng nhập trực tuyến nào.</td></tr>`;

  const lanLinksHtml = lanAddresses.map(item => `
    <li style="margin: 8px 0;">
      <span style="font-weight: 600; color: #475569;">${item.name}:</span>
      <a href="http://${item.address}:${PORT}" target="_blank" style="color: #2563eb; font-weight: 700; font-size: 16px; text-decoration: underline; margin-left: 8px;">
        http://${item.address}:${PORT}
      </a>
    </li>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <title>SmartHR - Bảng Giám Sát LAN & Realtime Sync Hub</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f1f5f9; margin: 0; padding: 24px; color: #0f172a; }
    .container { max-width: 1000px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; overflow: hidden; }
    .header { background: linear-gradient(135deg, #1e3a8a 0%, #0284c7 100%); color: white; padding: 24px 32px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; padding: 24px 32px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; }
    .stat-card { background: white; padding: 16px 20px; border-radius: 8px; border: 1px solid #e2e8f0; }
    .stat-card .label { font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase; }
    .stat-card .value { font-size: 26px; font-weight: 800; color: #0f172a; margin-top: 4px; }
    .content { padding: 32px; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; margin-bottom: 24px; }
    th { background: #f8fafc; padding: 12px 16px; font-weight: 700; color: #475569; border-bottom: 2px solid #e2e8f0; }
    .lan-box { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 22px;">SmartHR - Máy Chủ LAN & Realtime Sync Hub</h1>
      <p style="margin: 6px 0 0 0; opacity: 0.9; font-size: 14px;">Falcon EDR Safe - Tự động đồng bộ thời gian thực không cần xuất nhập file</p>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">Người Dùng Trực Tuyến</div>
        <div class="value" style="color: #16a34a;">${allUsers.length} <span style="font-size: 14px; font-weight: normal; color: #64748b;">user</span></div>
      </div>
      <div class="stat-card">
        <div class="label">Máy Khách Đã Kết Nối</div>
        <div class="value" style="color: #0284c7;">${allClients.length}</div>
      </div>
      <div class="stat-card">
        <div class="label">Tổng Lượt Thay Đổi (Mutations)</div>
        <div class="value" style="color: #ea580c;">${syncMutationJournal.length}</div>
      </div>
      <div class="stat-card">
        <div class="label">Cổng Lắng Nghe</div>
        <div class="value">${PORT}</div>
      </div>
    </div>
    <div class="content">
      <div class="lan-box">
        <div style="font-weight: 700; color: #1e3a8a; margin-bottom: 8px;">🌐 ĐƯỜNG DẪN TRUY CẬP CHO MÁY KHÁC TRONG MẠNG LAN:</div>
        <ul style="margin: 0; padding-left: 20px;">${lanLinksHtml}</ul>
      </div>
      <h3 style="margin: 0 0 12px 0;">👥 Danh Sách Người Dùng Trực Tuyến (Online Realtime)</h3>
      <table>
        <thead>
          <tr>
            <th>STT</th>
            <th>Họ Tên (Tài khoản)</th>
            <th>Vai Trò</th>
            <th>IP Kết Nối</th>
            <th>Phân Hệ Đang Mở</th>
            <th>Trạng Thái</th>
          </tr>
        </thead>
        <tbody>
          ${userRowsHtml}
        </tbody>
      </table>
      <div style="text-align: right;">
        <a href="/" style="display: inline-block; background: #0284c7; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 700;">🚀 Vào Ứng Dụng SmartHR</a>
      </div>
    </div>
  </div>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function serveFallbackSpa(req, res) {
  const indexPath = path.join(STATIC_ROOT, 'index.html');
  fs.stat(indexPath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h3>Chưa tìm thấy dist/index.html. Vui lòng chạy npm run build.</h3>');
      return;
    }
    serveFile(req, res, indexPath, stats, true);
  });
}

function serveFile(req, res, filePath, stat, isSpaFallback = false) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const etag = generateETag(stat);

  const headers = {
    'Content-Type': contentType,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Last-Modified': stat.mtime.toUTCString(),
    'ETag': etag
  };

  if (ext === '.html' || isSpaFallback) {
    headers['Cache-Control'] = 'no-cache, must-revalidate';
  } else {
    headers['Cache-Control'] = 'public, max-age=3600';
  }

  const clientEtag = req.headers['if-none-match'];
  const clientModifiedSince = req.headers['if-modified-since'];

  if (clientEtag === etag || (clientModifiedSince && new Date(clientModifiedSince) >= stat.mtime)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (req.method === 'HEAD') {
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    res.end();
    return;
  }

  const acceptEncoding = req.headers['accept-encoding'] || '';
  const isCompressible = /\b(text\/|application\/javascript|application\/json|application\/wasm|image\/svg\+xml)/i.test(contentType);

  const rawStream = fs.createReadStream(filePath);

  rawStream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('500 Internal Server Error');
    }
  });

  if (isCompressible && acceptEncoding.includes('gzip')) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    rawStream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
  } else if (isCompressible && acceptEncoding.includes('deflate')) {
    headers['Content-Encoding'] = 'deflate';
    res.writeHead(200, headers);
    rawStream.pipe(zlib.createDeflate()).pipe(res);
  } else {
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    rawStream.pipe(res);
  }
}

// 7. Khởi động
server.listen(PORT, HOST, () => {
  const lanAddresses = getLanAddresses();

  console.log('\n============================================================');
  console.log('   SMARTHR - STANDALONE LAN SERVER & REALTIME SYNC HUB');
  console.log('============================================================');
  console.log(`  Thư mục tĩnh:   ${STATIC_ROOT}`);
  console.log(`  Cổng lắng nghe: ${PORT}`);
  console.log('------------------------------------------------------------');
  console.log(`  > Máy nội bộ (Local):   http://localhost:${PORT}`);
  console.log(`  > Mạng LAN (Cùng mạng):`);
  
  if (lanAddresses.length === 0) {
    console.log(`    http://<Địa-Chỉ-IP-Máy-Này>:${PORT}`);
  } else {
    for (const item of lanAddresses) {
      console.log(`    http://${item.address}:${PORT}  (${item.name})`);
    }
  }

  console.log('------------------------------------------------------------');
  console.log(`  🔍 TRANG GIÁM SÁT KẾT NỐI MÁY KHÁCH LAN:`);
  console.log(`     http://localhost:${PORT}/status`);
  console.log('------------------------------------------------------------');
  console.log('  * Bảo mật: Falcon EDR Safe (0 child process, Stream I/O)');
  console.log('  * Header:  COOP + COEP enabled (Hỗ trợ ONNX WASM Multithread)');
  console.log('  * Đồng bộ: Realtime SSE & Delta Mutate Hub sẵn sàng');
  console.log('  * Phím tắt: Bấm Ctrl + C để dừng server');
  console.log('============================================================\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[LỖI] Cổng ${PORT} đang bận.`);
    process.exit(1);
  } else {
    console.error('[LỖI SERVER]', err);
    process.exit(1);
  }
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
