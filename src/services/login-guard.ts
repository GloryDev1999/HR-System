/**
 * login-guard — chống dò mật khẩu (brute-force) ở tầng frontend, 0đ.
 *
 * Lưu ý kiến trúc: đây là LỚP PHÒNG THỦ NGOÀI CÙNG, không thay thế
 * rate-limit phía server của Supabase Auth. Attacker xóa localStorage
 * sẽ vượt qua lớp này, nhưng kết hợp với Supabase Auth rate-limit +
 * tắt signup công khai + MFA + mật khẩu mạnh thì chi phí tấn công tăng
 * lên rất nhiều trong khi user thật gần như không ảnh hưởng.
 *
 * Chính sách (theo từng tài khoản, cửa sổ 5 phút):
 *   >= 5 sai  → khóa 60s
 *   >= 8 sai  → khóa 300s
 *   >= 12 sai → khóa 900s (trần)
 */

const STORAGE_KEY = 'smarthr_login_guard_v1';
const WINDOW_MS = 5 * 60 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;

interface FailEntry {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

type GuardStore = Record<string, FailEntry>;

function safeLoad(): GuardStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as GuardStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function safeSave(store: GuardStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage đầy / bị chặn: bỏ qua, server-side vẫn bảo vệ
  }
}

function lockMsFor(count: number): number {
  if (count >= 12) return 15 * 60 * 1000;
  if (count >= 8) return 5 * 60 * 1000;
  if (count >= 5) return 60 * 1000;
  return 0;
}

export interface GateResult {
  allowed: boolean;
  retryAfterSec: number;
}

export function normalizeGuardKey(emailOrUsername: string): string {
  return emailOrUsername.trim().toLowerCase();
}

/** Kiểm tra tài khoản có đang bị khóa tạm thời không. */
export function checkLoginAllowed(emailOrUsername: string, now = Date.now()): GateResult {
  const key = normalizeGuardKey(emailOrUsername);
  if (!key) return { allowed: true, retryAfterSec: 0 };
  const entry = safeLoad()[key];
  if (!entry) return { allowed: true, retryAfterSec: 0 };
  // Hết cửa sổ mà không vi phạm tiếp → coi như sạch
  if (now - entry.firstAt > WINDOW_MS && now >= entry.lockedUntil) {
    return { allowed: true, retryAfterSec: 0 };
  }
  if (now < entry.lockedUntil) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/** Ghi nhận 1 lần đăng nhập sai. Trả về thời gian khóa (s), 0 = chưa khóa. */
export function recordLoginFailure(emailOrUsername: string, now = Date.now()): number {
  const key = normalizeGuardKey(emailOrUsername);
  if (!key) return 0;
  const store = safeLoad();
  const prev = store[key];
  const entry: FailEntry =
    prev && now - prev.firstAt <= WINDOW_MS
      ? { ...prev, count: prev.count + 1 }
      : { count: 1, firstAt: now, lockedUntil: 0 };
  const lockMs = Math.min(lockMsFor(entry.count), MAX_LOCK_MS);
  if (lockMs > 0) entry.lockedUntil = now + lockMs;
  store[key] = entry;
  safeSave(store);
  return Math.round(lockMs / 1000);
}

/** Đăng nhập đúng → xóa vết sai của tài khoản. */
export function recordLoginSuccess(emailOrUsername: string): void {
  const key = normalizeGuardKey(emailOrUsername);
  if (!key) return;
  const store = safeLoad();
  if (store[key]) {
    delete store[key];
    safeSave(store);
  }
}

/** Thông báo khóa chuẩn cho UI. */
export function lockoutMessage(retryAfterSec: number): string {
  const m = Math.floor(retryAfterSec / 60);
  const s = retryAfterSec % 60;
  const when = m > 0 ? `${m} phút ${s} giây` : `${s} giây`;
  return `Tài khoản tạm khóa sau nhiều lần nhập sai. Vui lòng thử lại sau ${when}.`;
}
