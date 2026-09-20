/**
 * LAN Push Guard — kiểm thử công tắc chống loop & chống spam (P0-1 revive).
 * Quy ước user 2026-09-20: realtime 2 chiều mọi role; bulk/file/seed + remote-apply
 * không bao giờ đẩy LAN.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  setLanPushHandler,
  shouldPushLan,
  emitLanPush,
  runWithoutLanPush,
  runAsRemoteApply,
} from './lan-push-guard';

beforeEach(() => {
  setLanPushHandler(null);
});

describe('lan-push-guard', () => {
  it('không đẩy khi chưa đăng ký handler (an toàn mặc định, vd trong test)', () => {
    expect(shouldPushLan()).toBe(false);
    expect(() => emitLanPush({ table: 'employees', action: 'put', record: { a: 1 } })).not.toThrow();
  });

  it('đẩy khi đã đăng ký handler và chạy qua http', () => {
    const handler = vi.fn();
    setLanPushHandler(handler);
    // jsdom chạy http://localhost → đủ điều kiện protocol
    expect(shouldPushLan()).toBe(true);
    emitLanPush({ table: 'shiftRosters', action: 'put', record: { employeeId_date: 'X_2026-09-20' } });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ table: 'shiftRosters', action: 'put' });
  });

  it('nuốt lỗi handler để không gãy ghi local-first', () => {
    setLanPushHandler(() => { throw new Error('mang LAN dut'); });
    expect(() => emitLanPush({ table: 'employees', action: 'delete', key: 'E1' })).not.toThrow();
  });

  it('runWithoutLanPush chặn đẩy trong bulk, kể cả lồng nhau, rồi phục hồi', async () => {
    const handler = vi.fn();
    setLanPushHandler(handler);
    await runWithoutLanPush(async () => {
      emitLanPush({ table: 'employees', action: 'put', record: {} });
      await runWithoutLanPush(async () => {
        emitLanPush({ table: 'employees', action: 'put', record: {} });
      });
      emitLanPush({ table: 'shiftRosters', action: 'put', record: {} });
    });
    expect(handler).not.toHaveBeenCalled();
    // Ra khỏi bulk → đẩy lại bình thường
    emitLanPush({ table: 'employees', action: 'put', record: {} });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('runAsRemoteApply chặn đẩy ngược (chống loop ping-pong giữa các máy)', async () => {
    const handler = vi.fn();
    setLanPushHandler(handler);
    await runAsRemoteApply(async () => {
      emitLanPush({ table: 'productivityQualityRates', action: 'put', record: {} });
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('bulk và remote lồng nhau vẫn phục hồi đúng', async () => {
    const handler = vi.fn();
    setLanPushHandler(handler);
    await runWithoutLanPush(async () => {
      await runAsRemoteApply(async () => {
        emitLanPush({ table: 'employees', action: 'put', record: {} });
      });
    });
    expect(handler).not.toHaveBeenCalled();
    expect(shouldPushLan()).toBe(true);
  });
});
