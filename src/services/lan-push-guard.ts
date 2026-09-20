/**
 * SmartHR LAN Push Guard — công tắc chống loop & chống spam cho kênh GỬI realtime.
 *
 * Vai trò (P0-1 revive, quyết user 2026-09-20: realtime 2 chiều cho MỌI role):
 *  - Dexie hooks trong src/db/index.ts gọi emitLanPush() mỗi khi bản ghi tay đổi.
 *  - lan-sync-service đăng ký handler duy nhất 1 lần (setLanPushHandler) để POST
 *    lên server journal. Mọi máy (host + dept) vừa gửi vừa nhận như nhau.
 *
 * Chặn 3 trường hợp (quyết theo report.md + luật kênh file):
 *  1. Remote-apply: mutation từ máy khác nạp vào Dexie KHÔNG được đẩy ngược
 *     lên server (không là ping-pong loop giữa các máy).
 *  2. Bulk/file/seed: nạp Excel 20k dòng, ingest JSON OneDrive, seed DB, snapshot
 *     KHÔNG đẩy từng bản ghi (spam LAN). File đi đường file (luật kênh).
 *  3. Chưa login qua http / chưa đăng ký handler (test, file://): không đẩy.
 *
 * ZERO-DEPENDENCY, không import gì khác → db/index.ts và lan-sync-service.ts
 * đều import module này mà không tạo vòng lặp import (cycle).
 */

export type LanPushAction = 'put' | 'delete';

export interface LanPushEvent {
  table: string;
  action: LanPushAction;
  record?: any;
  key?: any;
}

type PushHandler = (e: LanPushEvent) => unknown;

let pushHandler: PushHandler | null = null;
let remoteDepth = 0; // >0 khi đang nạp mutation từ máy khác vào Dexie
let bulkDepth = 0; // >0 khi đang chạy bulk/file/seed (không đẩy LAN)

/** lan-sync-service gọi 1 lần lúc khởi động để đấu dây gửi. */
export function setLanPushHandler(fn: PushHandler | null): void {
  pushHandler = fn;
}

/** true khi một thay đổi tay được phép đẩy lên server LAN. */
export function shouldPushLan(): boolean {
  if (pushHandler === null) return false;
  if (remoteDepth > 0 || bulkDepth > 0) return false;
  if (typeof window === 'undefined') return false;
  if (!window.location.protocol.startsWith('http')) return false;
  return true;
}

/**
 * Dexie hooks gọi hàm này (fire-and-forget, KHÔNG await trong hook).
 * Tự nuốt lỗi để không bao giờ làm gãy ghi local-first.
 */
export function emitLanPush(e: LanPushEvent): void {
  if (!shouldPushLan()) return;
  try {
    const r = pushHandler!(e);
    if (r && typeof (r as Promise<unknown>).catch === 'function') {
      (r as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Bỏ qua: local-first không được phụ thuộc mạng LAN
  }
}

/** Bọc các luồng bulk/file/seed/snapshot: ghi Dexie nhưng không đẩy LAN. */
export async function runWithoutLanPush<T>(fn: () => Promise<T> | T): Promise<T> {
  bulkDepth++;
  try {
    return await fn();
  } finally {
    bulkDepth--;
  }
}

/** Bọc applyRemoteMutation: nạp dữ liệu máy khác nhưng không đẩy ngược. */
export async function runAsRemoteApply<T>(fn: () => Promise<T> | T): Promise<T> {
  remoteDepth++;
  try {
    return await fn();
  } finally {
    remoteDepth--;
  }
}
