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
 *   Foreign-port: neu 4173 ban ma khong phai do trung tam mo (server cu sot,
 *   start-server.bat chay tay, app khac chiem) thi status/start/stop tra co
 *   `foreign` de UI mo hop huong dan netstat/taskkill thay vi bao sai.
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
  const livePid = pidAlive(pid) ? pid : null;
  return {
    online: !!h,
    pid: livePid,
    // foreign = cổng 4173 đang bận nhưng KHÔNG phải do trung tâm này mở
    // (server cũ sót lại, start-server.bat chạy tay, hoặc app khác chiếm).
    // Đây chính là ca "báo đang mở nhưng bấm đóng thì không có cổng để đóng".
    foreign: !!h && !livePid,
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
  if (st.online && st.pid) return { ok: true, reused: true, pid: st.pid };
  // Cổng bận nhưng không phải của mình → KHÔNG nhận vơ "đang hoạt động",
  // trả cờ foreign để UI mở hộp hướng dẫn giải phóng cổng.
  if (st.online && !st.pid) return { ok: false, foreign: true };
  const stale = readPid();
  if (stale && !pidAlive(stale)) { try { fs.unlinkSync(PID_FILE); } catch {} }
  if (!fs.existsSync(SERVER_JS)) return { ok: false, error: 'Không thấy file server.js trong thư mục' };

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
  return { ok: false, error: 'Quá 15 giây chưa thấy /api/health (cổng có thể đang bị chiếm)' };
}

async function stopServer() {
  const pid = readPid();
  if (!pid || !pidAlive(pid)) {
    if (pid && !pidAlive(pid)) { try { fs.unlinkSync(PID_FILE); } catch {} }
    // Không còn PID của mình: nếu cổng vẫn bận nghĩa là chương trình khác
    // đang chiếm → báo foreign thay vì "không có cổng cần đóng".
    const h = await healthCheck(SERVER_PORT);
    if (h) return { ok: false, foreign: true };
    return { ok: true, nothing: true };
  }
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
  body { font-family: "Aptos Narrow", "Segoe UI", Arial, sans-serif; background: #eef2f7; color: #0f172a; min-height: 100vh; font-size: 16px; }
  .hero { background: linear-gradient(135deg, #1e3a8a 0%, #0284c7 100%); color: #fff; padding: 28px 24px 34px; }
  .hero h1 { font-size: 22px; letter-spacing: .3px; }
  .hero p { opacity: .85; font-size: 13px; margin-top: 6px; }
  .pill { display: inline-flex; align-items: center; gap: 8px; margin-top: 14px; background: rgba(255,255,255,.15); border: 1px solid rgba(255,255,255,.35); padding: 7px 14px; border-radius: 999px; font-size: 13px; font-weight: 700; }
  .dot { width: 11px; height: 11px; border-radius: 50%; background: #f87171; }
  .dot.on { background: #4ade80; box-shadow: 0 0 10px #4ade80; animation: pulse 1.6s infinite; }
  .dot.busy { background: #fbbf24; box-shadow: 0 0 10px #fbbf24; animation: pulse 1.6s infinite; }
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
  .hint { background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; padding: 14px 16px; margin-top: 14px; font-size: 14px; line-height: 1.6; color: #78350f; }
  .hint b { color: #92400e; }
  .hint ol { margin: 8px 0 4px 20px; padding: 0; }
  .hint li { margin: 4px 0; }
  .cmd { display: flex; align-items: center; gap: 8px; background: #0f172a; color: #a5f3c0; border-radius: 8px; padding: 8px 10px; margin: 6px 0; font-family: Consolas, monospace; font-size: 12.5px; word-break: break-all; }
  .cmd button { margin-left: auto; border: 0; background: #22c55e; color: #052e16; border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 12px; font-weight: 800; white-space: nowrap; font-family: inherit; }
  .btn-row { display: flex; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
  .btn-small { border: 1px solid #bae6fd; background: #fff; border-radius: 10px; padding: 10px 14px; cursor: pointer; font-size: 14px; font-weight: 700; color: #0369a1; font-family: inherit; }
  .guide { text-align: left; }
  .guide h4 { font-size: 14px; margin: 12px 0 4px; color: #0f172a; }
  .guide p { font-size: 13.5px; color: #475569; line-height: 1.6; }
  .toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); background: #0f172a; color: #fff; padding: 12px 20px; border-radius: 12px; font-size: 13px; display: none; box-shadow: 0 10px 30px rgba(0,0,0,.3); }
  .overlay { position: fixed; inset: 0; background: rgba(15,23,42,.55); display: none; align-items: center; justify-content: center; z-index: 50; padding: 16px; }
  .overlay.show { display: flex; }
  .modal { background: #fff; border-radius: 16px; padding: 22px; max-width: 380px; width: 100%; box-shadow: 0 20px 60px rgba(0,0,0,.3); }
  .modal h3 { font-size: 15px; margin-bottom: 8px; }
  .modal p { font-size: 13px; color: #64748b; line-height: 1.55; margin-bottom: 18px; }
  .modal .row { display: flex; gap: 10px; }
  .modal .row button { flex: 1; border: 0; border-radius: 10px; padding: 12px; font-size: 14px; font-weight: 800; cursor: pointer; }
  .m-cancel { background: #f1f5f9; color: #475569; }
  .m-ok { background: linear-gradient(135deg, #dc2626, #ef4444); color: #fff; }
  .m-ok.blue { background: linear-gradient(135deg, #0369a1, #0284c7); }
</style>
</head>
<body>
  <div class="hero">
    <h1>Trung tâm điều khiển</h1>
    <p>Trung tâm mở cổng mạng tĩnh để kết nối các phòng ban (không cần thao tác file thủ công).</p>
    <div class="pill"><span class="dot" id="dot"></span><span id="statusText">Đang kiểm tra…</span></div>
  </div>
  <div class="wrap">
    <div class="cards">
      <div class="card">
        <h2>Mở cổng</h2>
        <p>Mở cổng 4173 để các phòng ban khác sắp ca cho nhân viên của mình. Cổng chỉ kết nối được khi đã mở và các máy dùng chung một mạng LAN.</p>
        <button class="btn btn-green" id="btnStart">&#9654; MỞ CỔNG</button>
      </div>
      <div class="card">
        <h2>Đóng cổng</h2>
        <p>Đóng cổng sau khi các máy khác đã ngắt kết nối hoặc hết việc. Đóng cổng không ảnh hưởng hệ thống trên máy này. Đóng tab không tắt cổng — hãy bấm nút này trước khi nghỉ.</p>
        <button class="btn btn-red" id="btnStop">&#9632; ĐÓNG CỔNG</button>
      </div>
      <div class="card">
        <h2>Mở hệ thống</h2>
        <p>Chỉ mở trang đăng nhập, KHÔNG mở cổng. Làm việc offline khi các máy khác không có việc. Chỉ mở cổng 4173 khi cần cho máy khác vào.</p>
        <button class="btn btn-blue" id="btnOpen">&#9673; MỞ HỆ THỐNG</button>
      </div>
    </div>
    <div class="panel">
      <h3>Địa chỉ cổng cho các máy khác</h3>
      <div id="lanList"><p style="color:#94a3b8;font-size:13px">Đang tải…</p></div>
      <div class="btn-row">
        <button class="btn-small" id="btnTestLan">🔍 Kiểm tra máy khác có vào được không</button>
      </div>
      <div class="stats"><span>Người online: <b id="stUsers">-</b></span><span>Thay đổi: <b id="stMut">-</b></span><span>Đã chạy: <b id="stUp">-</b></span><span>PID: <b id="stPid">-</b></span></div>
    </div>
    <div class="hint" id="lanHint" style="display:none">
      <b>Máy khác không vào được? Kiểm tra 3 điểm theo thứ tự:</b>
      <ol>
        <li><b>1. Cùng mạng LAN:</b> máy kia phải bắt cùng Wi-Fi/mạng dây với máy này (không dùng 4G, không khác tòa nhà).</li>
        <li><b>2. Tường lửa Windows:</b> bấm “Kiểm tra” ở trên. Nếu dòng <b>localhost vào được, IP LAN không vào được</b> thì tường lửa đang chặn. Mở CMD <b>quyền Admin</b> (chuột phải → Run as administrator) rồi chạy lệnh sau:</li>
      </ol>
      <div class="cmd"><span id="netshCmd">netsh advfirewall firewall add rule name="SmartHR-4173" dir=in action=allow protocol=TCP localport=4173</span><button id="btnCopyNetsh">Sao chép</button></div>
      <ol start="3">
        <li><b>3. Cổng bị chương trình khác chiếm:</b> nếu phía trên báo “đang bận” mà bấm Đóng/Mở đều không xong, xem hộp hướng dẫn giải phóng cổng.</li>
      </ol>
      <div class="btn-row"><button class="btn-small" id="btnGuide">📖 Hướng dẫn giải phóng cổng 4173</button></div>
    </div>
    <div class="panel"><h3>Nhật ký</h3><div id="log"></div></div>
    <div class="quit"><button id="btnQuit">Tắt trung tâm này</button></div>
  </div>
  <div class="toast" id="toast"></div>
  <div class="overlay" id="confirmOverlay" role="dialog" aria-modal="true">
    <div class="modal">
      <h3 id="confirmTitle">Xác nhận</h3>
      <p id="confirmMsg"></p>
      <div class="row">
        <button class="m-cancel" id="confirmNo">Hủy bỏ</button>
        <button class="m-ok" id="confirmYes">Đồng ý</button>
      </div>
    </div>
  </div>
  <div class="overlay" id="guideOverlay" role="dialog" aria-modal="true">
    <div class="modal guide" style="max-width:520px">
      <h3>Cổng 4173 đang bị chương trình khác chiếm</h3>
      <p>Trung tâm báo “đang mở” nhưng nút Đóng/Mở đều không điều khiển được là vì cổng đang bận bởi <b>server cũ còn sót, cửa sổ start-server.bat chạy tay, hoặc một app khác</b> — không phải do trung tâm này mở nên trung tâm không có quyền đóng.</p>
      <h4>Bước 1 — Tìm chương trình đang chiếm (CMD thường, không cần Admin)</h4>
      <div class="cmd"><span>netstat -ano | findstr :4173</span><button data-copy="netstat -ano | findstr :4173">Sao chép</button></div>
      <p>Nhìn cột cuối cùng lấy số <b>PID</b> ở dòng có <b>LISTENING</b>.</p>
      <h4>Bước 2 — Tắt đúng chương trình đó</h4>
      <div class="cmd"><span>taskkill /PID &lt;số PID&gt; /F</span><button data-copy="taskkill /PID ">Sao chép</button></div>
      <p>Ví dụ tìm được PID 1234 thì chạy: <b>taskkill /PID 1234 /F</b>. Xong quay lại bấm <b>MỞ CỔNG</b>.</p>
      <h4>Mẹo tránh bị lại</h4>
      <p>Từ nay chỉ mở cổng bằng nút <b>MỞ CỔNG</b> trong trung tâm này, không chạy thêm <b>start-server.bat</b> hay cửa sổ đen nào khác.</p>
      <div class="row" style="display:flex;gap:10px;margin-top:14px">
        <button class="m-cancel" id="guideClose" style="flex:1;border:0;border-radius:10px;padding:12px;font-size:14px;font-weight:800;cursor:pointer;background:#f1f5f9;color:#475569">Đã hiểu</button>
      </div>
    </div>
  </div>
<script>
const $ = (id) => document.getElementById(id);
function log(m) { const el = $("log"); const t = new Date().toLocaleTimeString("vi-VN"); el.textContent += "[" + t + "] " + m + "\\n"; el.scrollTop = el.scrollHeight; }
function toast(m) { const t = $("toast"); t.textContent = m; t.style.display = "block"; setTimeout(() => t.style.display = "none", 2600); }
function copyText(txt, okMsg) {
  const done = () => toast(okMsg || "Đã sao chép");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(done).catch(() => fallbackCopy(txt, done));
  } else { fallbackCopy(txt, done); }
}
function fallbackCopy(txt, done) {
  const ta = document.createElement("textarea");
  ta.value = txt; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { toast("Không sao chép được, hãy chép tay"); }
  document.body.removeChild(ta);
}
function showGuide() { $("guideOverlay").classList.add("show"); }
function hideGuide() { $("guideOverlay").classList.remove("show"); }
// Modal xac nhan noi bo (Zero Native Dialogs theo agent.md — khong dung confirm()).
function askConfirm(title, msg, okLabel) {
  return new Promise((resolve) => {
    const ov = $("confirmOverlay");
    $("confirmTitle").textContent = title;
    $("confirmMsg").textContent = msg;
    const yes = $("confirmYes"), no = $("confirmNo");
    yes.textContent = okLabel || "Đồng ý";
    const done = (v) => { ov.classList.remove("show"); yes.onclick = null; no.onclick = null; ov.onclick = null; resolve(v); };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    ov.onclick = (e) => { if (e.target === ov) done(false); };
    ov.classList.add("show");
  });
}
async function refresh() {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    const s = await r.json();
    const dot = $("dot"), txt = $("statusText");
    if (s.foreign) {
      dot.classList.remove("on"); dot.classList.add("busy");
      txt.textContent = "Cổng " + s.port + " đang bận (không phải do trung tâm mở)";
    } else if (s.online) {
      dot.classList.remove("busy"); dot.classList.add("on");
      txt.textContent = "Cổng " + s.port + " đang mở";
    } else {
      dot.classList.remove("on"); dot.classList.remove("busy");
      txt.textContent = "Cổng " + s.port + " chưa mở";
    }
    $("btnStart").disabled = s.online && !s.foreign;
    $("btnStop").disabled = !s.online && !s.pid;
    // Hộp hướng dẫn tường lửa chỉ cần khi cổng đang chạy (online hoặc bị chiếm).
    $("lanHint").style.display = (s.online || s.foreign) ? "block" : "none";
    $("stUsers").textContent = (s.onlineUsers || []).length;
    $("stMut").textContent = s.totalMutations;
    $("stUp").textContent = s.uptime ? Math.floor(s.uptime / 60) + " phút" : "-";
    $("stPid").textContent = s.pid || "-";
    const box = $("lanList"); box.innerHTML = "";
    (s.lan || []).forEach((n) => {
      const url = "http://" + n.address + ":" + s.port;
      const d = document.createElement("div"); d.className = "lan";
      d.innerHTML = "<a target='_blank' rel='noopener'></a><button>Copy</button>";
      d.querySelector("a").href = url; d.querySelector("a").textContent = url + "  (" + n.name + ")";
      d.querySelector("button").onclick = () => copyText(url, "Đã sao chép " + url);
      box.appendChild(d);
    });
    if (!(s.lan || []).length) box.innerHTML = "<p style='color:#94a3b8;font-size:13px'>(chưa thấy IP mạng LAN)</p>";
  } catch (e) { $("statusText").textContent = "Mất kết nối trung tâm — thử tải lại trang"; }
}
$("btnStart").onclick = async () => {
  $("btnStart").disabled = true; log("Đang mở cổng…");
  try {
    const r = await fetch("/api/start", { method: "POST" });
    const j = await r.json();
    if (j.ok) {
      log(j.reused ? "Cổng đã mở sẵn từ trước." : "Cổng 4173 đã mở (tiến trình số " + j.pid + ").");
      toast("Cổng đang mở");
    } else if (j.foreign) {
      log("Cổng 4173 đang bị chương trình khác chiếm — mở hướng dẫn xử lý.");
      showGuide();
    } else { log("Lỗi: " + (j.error || "không rõ")); toast(j.error || "Mở cổng thất bại"); }
  } catch (e) { log("Lỗi kết nối trung tâm."); }
  refresh();
};
$("btnStop").onclick = async () => {
  const ok = await askConfirm("Đóng cổng?", "Máy khác trong LAN sẽ mất kết nối. Hệ thống trên máy này vẫn chạy offline bình thường.", "Đóng cổng");
  if (!ok) return;
  try {
    const r = await fetch("/api/stop", { method: "POST" });
    const j = await r.json();
    if (j.ok) { log(j.nothing ? "Cổng đang đóng sẵn, không có gì để đóng." : "Đã đóng cổng."); }
    else if (j.foreign) { log("Cổng đang bị chương trình khác chiếm — mở hướng dẫn xử lý."); showGuide(); }
    else { log("Lỗi: " + (j.error || "không rõ")); }
  } catch (e) { log("Lỗi kết nối trung tâm."); }
  refresh();
};
$("btnOpen").onclick = async () => {
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    const s = await r.json();
    if (s.online) { window.open("http://localhost:" + s.port, "_blank"); return; }
    // Cổng chưa mở: nếu máy khác đang làm host thì mở theo cổng đó.
    const h = await (await fetch("/api/hostfile", { cache: "no-store" })).json();
    if (h.url) { toast("Máy này chưa mở cổng — mở theo máy " + h.host); window.open(h.url, "_blank"); return; }
    // Không cổng, không host: làm việc offline qua /app (loopback, không mở cổng LAN).
    toast("Mở chế độ offline (không cần mở cổng)");
    window.open("/app", "_blank");
  } catch (e) { toast("Lỗi kết nối trung tâm."); }
};
$("btnQuit").onclick = async () => {
  const ok = await askConfirm("Tắt trung tâm?", "Bảng điều khiển sẽ dừng. Cổng 4173 vẫn mở nếu đang hoạt động.", "Tắt trung tâm");
  if (!ok) return;
  await fetch("/api/quit", { method: "POST" }).catch(() => {});
  document.body.innerHTML = "<p style='padding:40px;text-align:center'>Đã tắt trung tâm. Hãy đóng tab này lại.</p>";
};
$("guideClose").onclick = hideGuide;
$("guideOverlay").onclick = (e) => { if (e.target === $("guideOverlay")) hideGuide(); };
$("btnGuide").onclick = showGuide;
$("btnCopyNetsh").onclick = () => copyText($("netshCmd").textContent, "Đã sao chép lệnh mở tường lửa");
document.querySelectorAll("[data-copy]").forEach((b) => {
  b.onclick = () => copyText(b.getAttribute("data-copy"), "Đã sao chép lệnh");
});
$("btnTestLan").onclick = async () => {
  // Tự kiểm tra: trình duyệt máy này gọi thẳng IP LAN như máy khác vẫn làm.
  // localhost vào được mà IP LAN không vào được gần như chắc chắn là tường lửa.
  try {
    const r = await fetch("/api/status", { cache: "no-store" });
    const s = await r.json();
    if (!s.online && !s.foreign) { toast("Cổng chưa mở — bấm MỞ CỔNG trước"); log("Kiểm tra LAN: cổng chưa mở nên chưa kiểm tra."); return; }
    const port = s.port;
    log("Kiểm tra LAN: đang thử " + ((s.lan || []).length) + " địa chỉ…");
    try {
      await fetch("http://localhost:" + port + "/api/health", { cache: "no-store" });
      log("✔ Máy này (localhost:" + port + ") vào được.");
    } catch (e) { log("✘ Ngay cả máy này cũng không vào được localhost — hãy bấm MỞ CỔNG lại."); return; }
    let lanOk = false;
    for (const n of (s.lan || [])) {
      const url = "http://" + n.address + ":" + port + "/api/health";
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        await fetch(url, { cache: "no-store", signal: ctrl.signal });
        clearTimeout(t);
        log("✔ Địa chỉ LAN " + n.address + " (" + n.name + ") vào được — máy khác dùng địa chỉ này.");
        lanOk = true;
      } catch (e) { log("✘ Địa chỉ LAN " + n.address + " (" + n.name + ") không vào được."); }
    }
    if (!lanOk) {
      log("Kết luận: localhost được mà IP LAN không được → tường lửa Windows đang chặn. Làm theo hộp vàng phía trên.");
      toast("Khả năng tường lửa đang chặn — xem hộp vàng");
    } else { toast("Cổng mở tốt cho mạng LAN"); }
  } catch (e) { toast("Lỗi kết nối trung tâm."); }
};
refresh(); setInterval(refresh, 3000);
log("Trung tâm điều khiển đã sẵn sàng.");
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
    json(res, { status: 'offline', manager: true, note: 'Mở cổng 4173 để đồng bộ' }, 503);
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

// Double-click .lnk 2 lần / mo-ui.vbs sót: cổng 4179 đã có chủ → thoát êm
// (mo-ui.vbs đã hỏi trước, đây là lưới chắn thứ 2, không crash im lặng).
manager.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log('[MANAGER] Trung tam da chay san, ban nay nhuong va thoat.');
    process.exit(0);
  }
  console.error('[MANAGER ERROR]', err);
  process.exit(1);
});
