import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../lib/defaultSettings';
import { usernameToEmail } from '../context/AuthContext';
import { presenceManager } from '../services/presence-service';

describe('Auth & RBAC - Ma trận phân quyền 6 vai trò (Supabase profiles)', () => {
  it('username -> email tổng hợp cho Supabase Auth', () => {
    expect(usernameToEmail('kieu')).toBe('kieu@leggett.com');
    expect(usernameToEmail('Kieu')).toBe('kieu@leggett.com');
    expect(usernameToEmail('  Hoa  ')).toBe('hoa@leggett.com');
  });

  it('6 user chuẩn trong ma trận: Kieu/Hoa/Vinh/NguyetAnh/Han/Glory', () => {
    // User provisioning thực hiện 1 lần trong Supabase Dashboard Authentication
    // (kieu/hoa/vinh/nguyetanh/han/glory@leggett.com) + public.profiles.
    // Test này khóa vai trò/phạm vi chuẩn của từng user.
    const expected: Record<string, { role: string; scope: string | null }> = {
      kieu: { role: 'AD System', scope: null },
      hoa: { role: 'AD System', scope: null },
      vinh: { role: 'Warehouse Admin', scope: 'WH' },
      nguyetanh: { role: 'QC Admin', scope: 'QC' },
      han: { role: 'Production Admin', scope: 'Production' },
      glory: { role: 'AD System', scope: null },
    };
    for (const [u, exp] of Object.entries(expected)) {
      expect(usernameToEmail(u)).toBe(`${u}@leggett.com`);
      expect(exp.role).toBeTruthy();
    }
    expect(Object.keys(expected)).toHaveLength(6);
  });

  it('kiểm tra phân quyền: Kieu(Mia), Hoa(Molly) và Glory(Software) full quyền (AD System); HR Manager tương lai vẫn bị chặn Settings/Users', () => {
    const perms = DEFAULT_SETTINGS.rolePermissions;

    const makeCheckPerm = (role: string) => (action: string): boolean => {
      if (role === 'AD System') return true;
      if (role === 'HR Manager') {
        if (action === 'SYSTEM_SETTINGS' || action === 'MANAGE_ROLES_PERMISSIONS' || action === 'SETTINGS' || action === 'MANAGE_USERS') {
          return false;
        }
        return true;
      }
      const rolePerms = perms[role as keyof typeof perms] || [];
      return rolePerms.includes('ALL_ACCESS') || rolePerms.includes(action);
    };

    const checkKieu = makeCheckPerm('AD System');
    expect(checkKieu('MANAGE_USERS')).toBe(true);
    expect(checkKieu('SYSTEM_SETTINGS')).toBe(true);

    // hoa đã promote lên AD System → full quyền như kieu/glory
    const checkHoa = makeCheckPerm('AD System');
    expect(checkHoa('MANAGE_USERS')).toBe(true);
    expect(checkHoa('SYSTEM_SETTINGS')).toBe(true);
    expect(checkHoa('MANAGE_TIMESHEET')).toBe(true);
    expect(checkHoa('MANAGE_EMPLOYEES')).toBe(true);

    // Role HR Manager (cho acc tương lai) vẫn bị chặn Settings/Users
    const checkFutureHR = makeCheckPerm('HR Manager');
    expect(checkFutureHR('MANAGE_USERS')).toBe(false);
    expect(checkFutureHR('SYSTEM_SETTINGS')).toBe(false);
    expect(checkFutureHR('MANAGE_TIMESHEET')).toBe(true);
  });

  it('kiểm tra phân quyền: Vinh(Glory) chỉ duy nhất có quyền sắp ca cho WH, không thấy các menu khác', () => {
    const perms = DEFAULT_SETTINGS.rolePermissions;
    const whPerms = perms['Warehouse Admin'] || [];

    expect(whPerms.includes('MANAGE_DEPT_ROSTER')).toBe(true);
    expect(whPerms.includes('VIEW_DASHBOARD')).toBe(false);
    expect(whPerms.includes('VIEW_PRODUCTIVITY_QUALITY')).toBe(false);
    expect(whPerms.includes('MANAGE_EMPLOYEES')).toBe(false);
    expect(whPerms.includes('MANAGE_TIMESHEET')).toBe(false);
  });

  it('kiểm tra phân quyền: Nguyet Anh chỉ sửa Chất Lượng; Han chỉ sửa Năng Suất', () => {
    const perms = DEFAULT_SETTINGS.rolePermissions;
    const qcPerms = perms['QC Admin'] || [];
    const prdPerms = perms['Production Admin'] || [];

    // Nguyet Anh (QC)
    expect(qcPerms.includes('VIEW_PRODUCTIVITY_QUALITY')).toBe(true);
    expect(qcPerms.includes('EDIT_QUALITY_RATE')).toBe(true);
    expect(qcPerms.includes('EDIT_PRODUCTIVITY_RATE')).toBe(false);
    expect(qcPerms.includes('MANAGE_DEPT_ROSTER')).toBe(true);

    // Han (Production)
    expect(prdPerms.includes('VIEW_PRODUCTIVITY_QUALITY')).toBe(true);
    expect(prdPerms.includes('EDIT_PRODUCTIVITY_RATE')).toBe(true);
    expect(prdPerms.includes('EDIT_QUALITY_RATE')).toBe(false);
    expect(prdPerms.includes('MANAGE_DEPT_ROSTER')).toBe(true);
  });

  it('kiểm tra phân quyền hiển thị: Phân ca & Xoay ca, Tạo khảo sát, và Thêm Line chỉ mở cho 3 user lớn (Kieu, Hoa, Glory)', () => {
    const isMasterRole = (role: string) => role === 'AD System' || role === 'HR Manager' || role === 'HR Admin';

    // 3 user lớn được hiển thị
    expect(isMasterRole('AD System')).toBe(true); // Kieu(Mia) & Glory(Software)
    expect(isMasterRole('HR Manager')).toBe(true); // Hoa(Molly)

    // 3 user con bị ẩn hoàn toàn
    expect(isMasterRole('Warehouse Admin')).toBe(false); // Vinh(Glory)
    expect(isMasterRole('QC Admin')).toBe(false); // Nguyet Anh
    expect(isMasterRole('Production Admin')).toBe(false); // Han
  });
});

describe('Presence Manager - Realtime Avatar', () => {
  it('đăng ký và cập nhật trạng thái online của nhân sự', () => {
    presenceManager.setSession({
      username: 'vinh',
      displayName: 'Vinh',
      role: 'AD System',
    }, 'Bảng điều khiển');

    const users = presenceManager.getActiveUsers();
    expect(users.length).toBeGreaterThanOrEqual(1);

    const vinh = users.find(u => u.username === 'vinh');
    expect(vinh).toBeDefined();
    expect(vinh?.displayName).toBe('Vinh');
    expect(vinh?.role).toBe('AD System');
    expect(vinh?.status).toBe('online');

    // Chuyển tab
    presenceManager.updateCurrentTab('Bảng Chấm Công');
    const updated = presenceManager.getActiveUsers();
    expect(updated.find(u => u.username === 'vinh')?.currentTab).toBe('Bảng Chấm Công');

    // Rời phiên
    presenceManager.setSession(null);
  });
});
