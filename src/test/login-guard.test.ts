import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  lockoutMessage,
} from '../services/login-guard';

const USER = 'hoa@leggett.com';

beforeEach(() => {
  localStorage.clear();
});

describe('login-guard: throttle chống dò mật khẩu', () => {
  it('mới đầu cho phép', () => {
    expect(checkLoginAllowed(USER).allowed).toBe(true);
  });

  it('4 sai vẫn cho, sai thứ 5 khóa 60s', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) {
      expect(recordLoginFailure(USER, t0 + i * 1000)).toBe(0);
    }
    expect(checkLoginAllowed(USER, t0 + 5000).allowed).toBe(true);
    const lockSec = recordLoginFailure(USER, t0 + 5000);
    expect(lockSec).toBe(60);
    const gate = checkLoginAllowed(USER, t0 + 6000);
    expect(gate.allowed).toBe(false);
    expect(gate.retryAfterSec).toBeGreaterThan(0);
    expect(gate.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('hết thời gian khóa → cho lại', () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 5; i++) recordLoginFailure(USER, t0 + i * 1000);
    expect(checkLoginAllowed(USER, t0 + 6000).allowed).toBe(false);
    expect(checkLoginAllowed(USER, t0 + 70_000).allowed).toBe(true);
  });

  it('8 sai khóa 300s, >=12 sai khóa trần 900s', () => {
    const t0 = 3_000_000;
    let last = 0;
    for (let i = 0; i < 12; i++) last = recordLoginFailure(USER, t0 + i * 1000);
    expect(last).toBe(900);
    expect(checkLoginAllowed(USER, t0 + 12_000).retryAfterSec).toBeLessThanOrEqual(900);
  });

  it('đăng nhập đúng xóa vết sai', () => {
    const t0 = 4_000_000;
    for (let i = 0; i < 5; i++) recordLoginFailure(USER, t0 + i * 1000);
    expect(checkLoginAllowed(USER, t0 + 6000).allowed).toBe(false);
    recordLoginSuccess(USER);
    expect(checkLoginAllowed(USER, t0 + 6000).allowed).toBe(true);
  });

  it('qua cửa sổ 5 phút không sai thêm → sạch', () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 4; i++) recordLoginFailure(USER, t0 + i * 1000);
    expect(checkLoginAllowed(USER, t0 + 10 * 60_000).allowed).toBe(true);
  });

  it('lockoutMessage hiển thị phút/giây', () => {
    expect(lockoutMessage(45)).toContain('45 giây');
    expect(lockoutMessage(125)).toContain('2 phút');
  });

  it('username khác nhau không ảnh hưởng nhau, không phân biệt hoa thường', () => {
    const t0 = 6_000_000;
    for (let i = 0; i < 5; i++) recordLoginFailure('Hoa', t0 + i * 1000);
    expect(checkLoginAllowed('HOA', t0 + 6000).allowed).toBe(false);
    expect(checkLoginAllowed('kieu', t0 + 6000).allowed).toBe(true);
  });
});
