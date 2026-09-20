/**
 * SmartHR Quan Tri Web UI - Bang dieu khien dep cho Hoa/Kieu (thay WinForms)
 * ZERO-DEPENDENCY: chi dung node:http, node:fs, node:path, node:os, node:child_process.
 * Chay ngam hoan toan (khong cua so den): duoc mo boi mo-ui.vbs via wscript.
 *
 *   Manager  : http://127.0.0.1:4179  (chi may host tu dieu khien)
 *   Server   : http://localhost:4173  (LAN truy cap)
 *
  * 3 nut rieng biet:
 *   1. Mo Cong    : spawn node server.js an (windowsHide), luu PID %TEMP%
 *   2. Dong Cong  : kill PID do manager mo (co canh bao khi con user online)
 *   3. Mo He Thong: CHI mo trinh duyet, KHONG mo cong
 *      - Cong mo   -> http://localhost:4173 (LAN vao duoc)
 *      - Cong dong -> /app (app offline qua loopback, KHONG mo cong LAN)
 *   Tu vung UI: "cong" = server LAN 4173, "trung tam" = bang dieu khien nay.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_PORT = parseInt(process.env.PORT || '4173', 10);
const MANAGER_PORT = parseInt(process.env.MANAGER_PORT || '4179', 10);
const SERVER_JS = path.join(__dirname, 'server.js');
const DIST_ROOT = path.join(__dirname, 'dist'); // app offline serve qua /app (loopback)
const PID_FILE = path.join(os.tmpdir(), 'smarthr-server.pid');
const HOST_DIR = path.join(__dirname, 'HR_Data');
const HOST_FILE = path.join(HOST_DIR, '_current-host.json');
const FAVICON = path.join(__dirname, 'public', 'favicon.ico');

// ---------- helpers ----------
function getLanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const n of ifs[name] || []) {
      if (n.family === 'IPv4' && !n.internal) out.push({ name, address: n.address });
    }
  }
  return out;
}

function healthCheck(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const id = parseInt(raw, 10);
    return isNaN(id) ? null : id;
  } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

async function serverStatus() {
  const h = await healthCheck(SERVER_PORT);
  const pid = readPid();
  return {
    online: !!h,
    pid: pidAlive(pid) ? pid : null,
    stalePid: pid && !pidAlive(pid) ? pid : null,
    port: SERVER_PORT,
    lan: h?.lanAddresses || getLanIPs().map((x) => ({ name: x.name, address: x.address })),
    onlineUsers: h?.onlineUsers || [],
    totalMutations: h?.totalMutations ?? 0,
    uptime: h?.uptime ?? 0
  };
}

function writeHostFile(ip) {
  try {
    if (!fs.existsSync(HOST_DIR)) fs.mkdirSync(HOST_DIR, { recursive: true });
    const obj = {
      ip, port: SERVER_PORT, host: os.hostname(),
      updatedBy: os.userInfo().username, updatedAt: new Date().toISOString(),
      url: `http://${ip}:${SERVER_PORT}`
    };
    const tmp = HOST_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
    fs.renameSync(tmp, HOST_FILE);
  } catch (e) { console.error('[MANAGER] write host file:', e.message); }
}

async function startServer() {
  const st = await serverStatus();
  if (st.online) return { ok: true, reused: true, pid: st.pid };
  const stale = readPid();
  if (stale && !pidAlive(stale)) { try { fs.unlinkSync(PID_FILE); } catch {} }
  if (!fs.existsSync(SERVER_JS)) return { ok: false, error: 'Khong thay server.js' };

  // Spawn node bang array args (khong qua cmd) + windowsHide -> khong cua so den.
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true
  });
  child.unref();
  try { fs.writeFileSync(PID_FILE, String(child.pid), 'utf-8'); } catch {}

  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await healthCheck(SERVER_PORT);
    if (h) {
      const ips = getLanIPs();
      writeHostFile(ips.length > 0 ? ips[0].address : 'localhost');
      return { ok: true, pid: child.pid };
    }
  }
  return { ok: false, error: 'Qua 15s chua thay /api/health (port co the bi chiem)' };
}

async function stopServer() {
  const pid = readPid();
  if (!pid) return { ok: true, nothing: true };
  if (!pidAlive(pid)) { try { fs.unlinkSync(PID_FILE); } catch {} return { ok: true, nothing: true }; }
  try {
    const h = await healthCheck(SERVER_PORT);
    const n = h?.onlineUsers?.length ?? 0;
    process.kill(pid);
    try { fs.unlinkSync(PID_FILE); } catch {}
    return { ok: true, killedPid: pid, hadOnlineUsers: n };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------- pretty UI (single file, inline CSS/JS) ----------
const PAGE = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SmartHR - Trung tâm điều khiển</title>
<link rel="icon" href="/favicon.ico">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, "Segoe UI", sans-serif; background: #eef2f7; color: #0f172a; min-height: 100vh; }
  .hero { background: linear-gradient(135deg, #1e3a8a 0%, #0284c7 100%); color: #fff; padding: 28px 24px 34px; }
  .hero h1 { font-size: 22px; letter-spacing: .3px; }
  .hero p { opacity: .85; font-size: 13px; margin-top: 6px; }
  .pill { display: inline-flex; align-items: center; gap: 8px; margin-top: 14px; background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.35); padding: 7px 14px; border-radius: 999px; font-size: 13px; font-weight: 700; }
  .dot { width: 11px; height: 11px; border-radius: 50%; background: #f87171; }
  .dot.on { background: #4ade80; box-shadow: 0 0 10px #4ade80; animation: pulse 1.6s infinite; }
  @keyframes pulse { 50% { opacity: .5; } }
  .wrap { max-width: 860px; margin: -22px auto 40px; padding: 0 16px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; }
  .card { background: #fff; border-radius: 16px; padding: 20px; box-shadow: 0 8px 24px rgba(15,23,42,.08); border: 1px solid #e2e8f0; display: flex; flex-direction: column; gap: 10px; }
  .card .num { font-size: 12px; font-weight: 800; color: #94a3b8; letter-spacing: 1px; }
  .card h2 { font-size: 16px; }
  .card p { font-size: 12.5px; color: #64748b; line-height: 1.55; flex: 1; }
  .btn { border: 0; border-radius: 12px; padding: 14px; font-size: 15px; font-weight: 800; cursor: pointer; color: #fff; transition: transform .08s, filter .15s; }
  .btn:active { transform: scale(.97); }
  .btn:disabled { filter: grayscale(1); opacity: .55; cursor: not-allowed; }
  .btn-green { background: linear-gradient(135deg, #16a34a, #22c55e); box-shadow: 0 6px 16px rgba(34,197,94,.35); }
  .btn-red { background: linear-gradient(135deg, #dc2626, #ef4444); box-shadow: 0 6px 16px rgba(239,68,68,.35); }
  .btn-blue { background: linear-gradient(135deg, #0369a1, #0284c7); box-shadow: 0 6px 16px rgba(2,132,199,.35); }
  .panel { background: #fff; border-radius: 16px; margin-top: 14px; padding: 20px; border: 1px solid #e2e8f0; box-shadow: 0 8px 24px rgba(15,23,42,.06); }
  .panel h3 { font-size: 14px; margin-bottom: 10px; }
  .lan { display: flex; align-items: center; gap: 10px; background: #f0f9ff; border: 1px dashed #7dd3fc; border-radius: 10px; padding: 10px 12px; margin: 8px 0; font-size: 14px; }
  .lan a { color: #0369a1; font-weight: 700; text-decoration: none; word-break: break-all; }
  .lan button { margin-left: auto; border: 1px solid #bae6fd; background: #fff; border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; font-weight: 700; color: #0369a1; white-space: nowrap; }
  #log { background: #0f172a; color: #a5f3c0; border-radius: 10px; padding: 12px; font-family: Consolas, monospace; font-size: 12px; height: 150px; overflow-y: auto; white-space: pre-wrap; }  .stats { display: flex; gap: 18px; margin-top: 10px; font-size: 12.5px; color: #475569; flex-wrap: wrap; }
  .stats b { color: #0f172a; }
  .quit { text-align: center; margin-top: 16px; }
  .quit button { background: none; border: 0; color: #94a3b8; font-size: 12px; cursor: pointer; text-decoration: underline; }
  .toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); background: #0f172a; color: #fff; padding: 12px 20px; border-radius: 12px; font-size: 13px; display: none; box-shadow: 0 10px 30px rgba(0,0,0,.3); }
</style>
</head>
<body>
  <div class="hero">
    <h1>Trung tâm điều khiển</h1>
    <p>Trung tâm khởi tạo sever tĩnh để mở kết nối giữa các phòng ban.</p>
    <div class="pill"><span class="dot" id="dot"></span><span id="statusText">Dang kiem tra...</span></div>
  </div>
  <div class="wrap">
    <div class="cards">
      <div class="card">
        <h2>Mở Cổng</h2>
        <p>Mở cổng 4173 tĩnh để các phòng ban khác có thể sắp ca cho nhân viên của mình, cổng chỉ có thể kết nối khi được mở và cùng chung 1 LAN.</p>
        <button class="btn btn-green" id="btnStart">&#9654; MỞ CỔNG</button>
      </div>
      <div class="card">
        <h2>Đóng Cổng</h2>
        <p>Sau khi các user khác ngắt kết nối hoặc không còn phận sự hãy đóng cổng, tiến trình đóng cổng không ảnh hưởng hệ thống hoạt động, tắt trung tâm cổng vẫn mở nên hãy đóng cổng trước khi tắt hệ thống.</p>
        <button class="btn btn-red" id="btnStop">&#9632; ĐÓNG CỔNG</button>
      </div>
      <div class="card">
        <h2>Mở Hệ Thống</h2>
        <p>Chỉ mở trang đăng nhập, KHÔNG mở cổng. ưu tiên làm việc offline khi không các user khác không có phận sự. chỉ mở cổng 4173 khi cần mở cho user khác vào.</p>
        <button class="btn btn-blue" id="btnOpen">&#9673; M&#7902; H&#7878; TH&#7888;NG</button>
      </div>
    </div>
    <div class="panel">
      <h3>Địa chỉ cổng cho các user khác</h3>
      <div id="lanList"><p style="color:#94a3b8;font-size:13px">Dang tai...</p></div>
      <div class="stats"><span>User online: <b id="stUsers">-</b></span><span>Mutations: <b id="stMut">-</b></span><span>Uptime: <b id="stUp">-</b></span><span>PID: <b id="stPid">-</b></span></div>
    </div>
    <div class="panel"><h3>Nh&#7853;t k&#253;</h3><div id="log"></div></div>
    <div class="quit"><button id="btnQuit">Tắt trung tâm này</button></div>
  </div>
  <div class="toast" id="toast"></div>
<script>
const $ = (id) => document.getElementById(id);
function log(m) { const el = $("log"); const t = new Date().toLocaleTimeString("vi-VN"); el.textContent += "[" + t + "] " + m + "\\n"; el.scrollTop = el.scrollHeight; }
function toast(m) { const t = $("toast"); t.textContent = m; t.style.display = "block"; setTimeout(() => t.style.display = "none", 2600); }
async function refresh() {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    const s = await r.json();
    const dot = $("dot"), txt = $("statusText");
    if (s.online) { dot.classList.add("on"); txt.textContent = "Cổng " + s.port + " đang hoạt động"; }
    else { dot.classList.remove("on"); txt.textContent = "Cổng " + s.port + " chưa mở"; }
    $("btnStart").disabled = s.online;
    $("btnStop").disabled = !s.online && !s.pid;
    $("stUsers").textContent = (s.onlineUsers || []).length;
    $("stMut").textContent = s.totalMutations;
    $("stUp").textContent = s.uptime ? Math.floor(s.uptime / 60) + " phut" : "-";
    $("stPid").textContent = s.pid || "-";
    const box = $("lanList"); box.innerHTML = "";
    (s.lan || []).forEach((n) => {
      const url = "http://" + n.address + ":" + s.port;
      const d = document.createElement("div"); d.className = "lan";
      d.innerHTML = "<a target='_blank' rel='noopener'></a><button>Copy</button>";
      d.querySelector("a").href = url; d.querySelector("a").textContent = url + "  (" + n.name + ")";
      d.querySelector("button").onclick = () => { navigator.clipboard.writeText(url).then(() => toast("Da copy " + url)); };
      box.appendChild(d);
    });
    if (!(s.lan || []).length) box.innerHTML = "<p style='color:#94a3b8;font-size:13px'>(chua co IP LAN)</p>";
  } catch (e) { $("statusText").textContent = "Mat ket noi trinh quan tri"; }
}
$("btnStart").onclick = async () => {
  $("btnStart").disabled = true; log("Đang mở cổng...");
  try {
    const r = await fetch("/api/start", { method: "POST" });
    const j = await r.json();
    if (j.ok) { log(j.reused ? "Cổng đã mở sẵn." : "Cổng 4173 đang hoạt động (PID " + j.pid + ")."); toast("Cổng đang hoạt động"); }
    else { log("Lỗi: " + j.error); toast(j.error); }
  } catch (e) { log("Lỗi kết nối."); }
  refresh();
};
$("btnStop").onclick = async () => {
  if (!confirm("Đóng cổng? Máy khác trong LAN sẽ mất kết nối.")) return;
  try {
    const r = await fetch("/api/stop", { method: "POST" });
    const j = await r.json();
    log(j.ok ? (j.nothing ? "Không có cổng cần đóng." : "Đã đóng cổng.") : "Lỗi: " + j.error);
  } catch (e) { log("Lỗi kết nối."); }
  refresh();
};
$("btnOpen").onclick = async () => {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    const s = await r.json();
    if (s.online) { window.open("http://localhost:" + s.port, "_blank"); return; }
    // Cổng chưa mở: nếu máy khác đang host thì mở theo cổng đó.
    const h = await (await fetch("/api/hostfile", { cache: "no-store" })).json();
    if (h.url) { toast("Máy này chưa mở cổng - mở theo " + h.host); window.open(h.url, "_blank"); return; }
    // Không cổng, không host: làm việc offline qua /app (loopback, không mở cổng LAN).
    toast("Mở chế độ offline (không cần mở cổng)");
    window.open("/app", "_blank");
  } catch (e) { toast("Lỗi kết nối trung tâm."); }
};
$("btnQuit").onclick = async () => {
  if (!confirm("Tắt trung tâm? (cổng vẫn mở nếu đang hoạt động)")) return;
  await fetch("/api/quit", { method: "POST" }).catch(() => {});
  document.body.innerHTML = "<p style='padding:40px;text-align:center'>Đã tắt trung tâm. Đóng tab này lại.</p>";
};
refresh(); setInterval(refresh, 3000);
log("Trung tâm điều khiển sẵn sàng.");
</script>
</body>
</html>`;

// ---------- router ----------
function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
}

const manager = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const p = url.pathname;

  if (p === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(PAGE);
    return;
  }
  if (p === '/favicon.ico' && req.method === 'GET') {
    fs.stat(FAVICON, (err, st) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(FAVICON).pipe(res);
    });
    return;
  }
  if (p === '/api/status' && req.method === 'GET') { json(res, await serverStatus()); return; }
  if (p === '/api/hostfile' && req.method === 'GET') {
    try { json(res, JSON.parse(fs.readFileSync(HOST_FILE, 'utf-8'))); }
    catch { json(res, {}); }
    return;
  }
  // API của server.js NHƯNG gọi nhầm sang trung tâm (app tab /app dùng chung origin):
  // luôn 503 để app hiểu là offline. KHÔNG trả 200 giả — sẽ làm app tưởng cổng mở.
  if (
    (p === '/api/health' && req.method === 'GET') ||
    (p === '/api/realtime' && req.method === 'GET') ||
    (p === '/api/presence/heartbeat' && req.method === 'POST') ||
    (p === '/api/sync/mutate' && req.method === 'POST') ||
    (p === '/api/sync/pull' && req.method === 'GET')
  ) {
    if (req.method === 'POST') await readBody(req);
    json(res, { status: 'offline', manager: true, note: 'Mo cong 4173 de dong bo' }, 503);
    return;
  }
  if (p === '/api/start' && req.method === 'POST') { await readBody(req); json(res, await startServer()); return; }
  if (p === '/api/stop' && req.method === 'POST') { await readBody(req); json(res, await stopServer()); return; }
  if (p === '/api/quit' && req.method === 'POST') {
    await readBody(req);
    json(res, { ok: true });
    setTimeout(() => process.exit(0), 300);
    return;
  }
  // App offline: serve dist/ qua /app (loopback, KHÔNG mở cổng LAN).
  // Trình duyệt chặn window.open(file://) từ trang http nên không dùng file:// nữa.
  if (p === '/app' || p === '/app/') {
    serveAppFile(req, res, 'index.html');
    return;
  }
  if (p.startsWith('/app/')) {
    serveAppFile(req, res, p.slice(5));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------- serve dist/ cho chế độ offline (/app, loopback) ----------
const APP_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

function serveAppFile(req, res, rel) {
  let safe = path.normalize('/' + (rel || 'index.html')).replace(/^(\.\.[/\\])+/, '');
  if (safe === '/' || safe === '/.' || safe === '') safe = '/index.html';
  const filePath = path.join(DIST_ROOT, safe);
  if (path.resolve(filePath).indexOf(path.resolve(DIST_ROOT)) !== 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Chua co dist/index.html. Chay npm run build truoc.');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': APP_MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      // ONNX WASM đa luồng cần crossOriginIsolated như server.js
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    });
    fs.createReadStream(filePath).on('error', () => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }).pipe(res);
  });
}

// Chi bind loopback: may khac khong dieu khien duoc server cua Hoa/Kieu.
manager.listen(MANAGER_PORT, '127.0.0.1', () => {
  console.log(`[MANAGER] Trung tam dieu khien: http://127.0.0.1:${MANAGER_PORT}`);
  console.log(`[MANAGER] Cong LAN: ${SERVER_PORT} | App offline: http://127.0.0.1:${MANAGER_PORT}/app`);
});
