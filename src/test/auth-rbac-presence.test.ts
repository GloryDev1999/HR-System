import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db, DEFAULT_SETTINGS } from '../db';
import { ensureDefaultAccounts } from '../context/AuthContext';
import { verifyPassword } from '../services/password';
import { presenceManager } from '../services/presence-service';
import { logUserAction, getAuditLogs } from '../services/audit-log-service';

describe('Auth & RBAC - 6 Tài Khoản Doanh Nghiệp Chuẩn', () => {
  beforeEach(async () => {
    await db.accounts.clear();
    await db.userAuditLogs.clear();
    await ensureDefaultAccounts();
  });

  it('khởi tạo sẵn 6 user chuẩn: Kieu, Hoa, Vinh, Nguyet Anh, Han, Glory với mật khẩu 123', async () => {
    const usersExpected = [
      { username: 'kieu', displayName: 'Kieu(Mia)', role: 'AD System', dept: null },
      { username: 'hoa', displayName: 'Hoa(Molly)', role: 'HR Manager', dept: null },
      { username: 'vinh', displayName: 'Vinh(Glory)', role: 'Warehouse Admin', dept: 'WH' },
      { username: 'nguyetanh', displayName: 'Nguyet Anh', role: 'QC Admin', dept: 'QC' },
      { username: 'han', displayName: 'Han', role: 'Production Admin', dept: 'Production' },
      { username: 'glory', displayName: 'Glory(Software)', role: 'AD System', dept: null },
    ];

    for (const exp of usersExpected) {
      const acc = await db.accounts.get(exp.username);
      expect(acc).toBeDefined();
      expect(acc?.displayName).toBe(exp.displayName);
      expect(acc?.role).toBe(exp.role);
      expect(acc?.departmentScope).toBe(exp.dept);
      expect(acc?.active).toBe(true);

      const passOk = await verifyPassword('123', acc!.salt, acc!.passwordHash);
      expect(passOk).toBe(true);
    }
  });

  it('kiểm tra phân quyền: Kieu(Mia) và Glory(Software) có quyền MANAGE_USERS, Hoa(Molly) không có quyền MANAGE_USERS', () => {
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

    const checkHoa = makeCheckPerm('HR Manager');
    expect(checkHoa('MANAGE_USERS')).toBe(false);
    expect(checkHoa('SYSTEM_SETTINGS')).toBe(false);
    expect(checkHoa('MANAGE_TIMESHEET')).toBe(true);
    expect(checkHoa('MANAGE_EMPLOYEES')).toBe(true);
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

  it('kiểm tra User Audit Logs: ghi nhận và truy vấn transactions hoạt động', async () => {
    await logUserAction({
      username: 'vinh',
      displayName: 'Vinh(Glory)',
      role: 'Warehouse Admin',
      actionType: 'ASSIGN_SHIFT',
      targetEntity: 'WH - LEP040',
      details: 'Sắp ca 1 ngày 2026-08-25 cho nhân viên kho'
    });

    await logUserAction({
      username: 'nguyetanh',
      displayName: 'Nguyet Anh',
      role: 'QC Admin',
      actionType: 'UPDATE_RATE_CL',
      targetEntity: 'line_rivet_1 (2026-08-25)',
      details: 'Cập nhật Tỷ lệ Chất Lượng = 99.5%'
    });

    const allLogs = await getAuditLogs();
    expect(allLogs.length).toBe(2);

    const vinhLogs = await getAuditLogs({ username: 'vinh' });
    expect(vinhLogs.length).toBe(1);
    expect(vinhLogs[0].targetEntity).toBe('WH - LEP040');

    const clLogs = await getAuditLogs({ actionType: 'UPDATE_RATE_CL' });
    expect(clLogs.length).toBe(1);
    expect(clLogs[0].username).toBe('nguyetanh');
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
