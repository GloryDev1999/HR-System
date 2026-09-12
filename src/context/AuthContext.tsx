import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { RoleType, ISystemSettings, IAccount, SessionUser } from '../types';
import { db, DEFAULT_SETTINGS } from '../db';
import { generateSalt, hashPassword, verifyPassword } from '../services/password';
import { logUserAction } from '../services/audit-log-service';

interface AuthContextType {
  /** Phiên đăng nhập hiện tại; null = chưa đăng nhập */
  session: SessionUser | null;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ ok: boolean; error?: string }>;
  createAccount: (username: string, displayName: string, role: RoleType, password?: string, departmentScope?: string | null) => Promise<{ ok: boolean; error?: string }>;
  updateAccountProfile: (username: string, updates: { displayName?: string; role?: RoleType; departmentScope?: string | null; active?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  currentRole: RoleType | null;
  departmentScope: string | null; // null for company-wide, or 'WH', 'Production', 'QC'
  hasPermission: (action: string) => boolean;
  rolePermissions: ISystemSettings['rolePermissions'];
  systemSettings: ISystemSettings;
  refreshPermissions: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SESSION_KEY = 'smarthr_session';

/** Tài khoản mặc định khởi tạo lần đầu */
export const DEFAULT_ADMIN_USERNAME = 'kieu';
const DEFAULT_ADMIN_PASSWORD = '123';

export async function ensureDefaultAccounts(): Promise<void> {
  const seedUser = async (username: string, displayName: string, role: RoleType, pass: string, departmentScope: string | null = null) => {
    const existing = await db.accounts.get(username);
    if (!existing) {
      const salt = generateSalt();
      const account: IAccount = {
        username,
        displayName,
        role,
        departmentScope,
        salt,
        passwordHash: await hashPassword(pass, salt),
        active: true,
        activeFlag: 1,
        createdAt: new Date().toISOString(),
      };
      await db.accounts.put(account);
    } else {
      // Cập nhật đảm bảo vai trò & tên hiển thị và departmentScope
      const updatePayload: Partial<IAccount> = {
        displayName,
        role,
        departmentScope,
        active: true,
        activeFlag: 1,
      };
      await db.accounts.update(username, updatePayload as any);
    }
  };

  // 1. Kieu(Mia): System Admin, nắm toàn bộ master data toàn quyền hệ thống
  await seedUser('kieu', 'Kieu(Mia)', 'AD System', '123', null);

  // 2. Hoa(Molly): HR-System, thao tác toàn quyền hệ thống nhưng chỉ là client
  await seedUser('hoa', 'Hoa(Molly)', 'HR Manager', '123', null);

  // 3. Vinh(Glory): WH-Admin, chỉ duy nhất thao tác sắp ca cho duy nhất bộ phận wh
  await seedUser('vinh', 'Vinh(Glory)', 'Warehouse Admin', '123', 'WH');

  // 4. Nguyet Anh: QC-Admin, thao tác sắp ca cho bộ phận QC, chỉ duy nhất điền tỷ lệ chất lượng
  await seedUser('nguyetanh', 'Nguyet Anh', 'QC Admin', '123', 'QC');

  // 5. Han: Prd-Admin, thao tác sắp ca cho bộ phận sản xuất, chỉ chỉnh sửa tỷ lệ năng suất
  await seedUser('han', 'Han', 'Production Admin', '123', 'Production');

  // 6. Glory(Software): toàn quyền thao tác hệ thống để chịu trách nhiệm kỹ thuật
  await seedUser('glory', 'Glory(Software)', 'AD System', '123', null);
}

function getDepartmentScope(role: RoleType): string | null {
  switch (role) {
    case 'Warehouse Admin':
      return 'WH';
    case 'Production Admin':
      return 'Production';
    case 'QC Admin':
      return 'QC';
    default:
      return null;
  }
}

/**
 * Kiểm tra quyền NGHIÊM NGẶT theo ma trận RBAC:
 *  - AD System: Toàn quyền hệ thống
 *  - HR Manager: Toàn quyền NGOẠI TRỪ mục Cài đặt (SYSTEM_SETTINGS, MANAGE_ROLES_PERMISSIONS, SETTINGS) và Quản lý User (MANAGE_USERS)
 *  - Các vai trò khác: Theo quyền khai báo trong ma trận
 */
function makeHasPermission(role: RoleType | null, permissions: ISystemSettings['rolePermissions']) {
  return (action: string): boolean => {
    if (!role) return false;

    // Yêu cầu: HR Manager không được thao tác mục Cài đặt và Quản lý User hệ thống, còn lại toàn quyền
    if (role === 'HR Manager') {
      if (action === 'SYSTEM_SETTINGS' || action === 'MANAGE_ROLES_PERMISSIONS' || action === 'SETTINGS' || action === 'MANAGE_USERS') {
        return false;
      }
      return true; // Toàn quyền các mục còn lại
    }

    // Yêu cầu: AD System toàn quyền hệ thống
    if (role === 'AD System') {
      return true;
    }

    const perms = permissions[role] || [];
    return perms.includes('ALL_ACCESS') || perms.includes(action);
  };
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<SessionUser | null>(() => {
    // Khôi phục phiên trong cùng tab (sessionStorage - đóng tab là hết)
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as SessionUser) : null;
    } catch {
      return null;
    }
  });

  // RBAC từ Dexie settings (hybrid: Dexie > localStorage > DEFAULT)
  const dbSettingsEntry = useLiveQuery(() => db.settings.get('systemSettings'), []);

  const [systemSettings, setSystemSettings] = useState<ISystemSettings>(() => {
    const saved = localStorage.getItem('smarthr_settings');
    if (saved) {
      try { return JSON.parse(saved) as ISystemSettings; } catch { /* ignore */ }
    }
    return DEFAULT_SETTINGS;
  });

  useEffect(() => {
    if (dbSettingsEntry?.value) {
      setSystemSettings(dbSettingsEntry.value as ISystemSettings);
      localStorage.setItem('smarthr_settings', JSON.stringify(dbSettingsEntry.value));
    }
  }, [dbSettingsEntry]);

  // Khởi tạo các tài khoản mặc định (Vinh, Kiều, admin) đúng một lần
  useEffect(() => {
    ensureDefaultAccounts().catch(console.error);
  }, []);

  const persistSession = (s: SessionUser | null) => {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
    setSession(s);
  };

  const currentRole = session?.role ?? null;
  const rolePermissions = systemSettings?.rolePermissions || DEFAULT_SETTINGS.rolePermissions;
  const hasPermission = useCallback(
    makeHasPermission(currentRole, rolePermissions),
    [currentRole, rolePermissions]
  );

  const login = useCallback(async (username: string, password: string): Promise<{ ok: boolean; error?: string }> => {
    let uname = username.trim().toLowerCase();
    if (!uname || !password) return { ok: false, error: 'Vui lòng nhập tên đăng nhập và mật khẩu' };

    // Hỗ trợ gõ cả Kiều có dấu hoặc kieu không dấu
    if (uname === 'kiều') uname = 'kieu';

    let account = await db.accounts.get(uname);
    if (!account) {
      account = await db.accounts.filter(a => a.username.toLowerCase() === uname || a.displayName.toLowerCase() === uname).first();
    }

    if (!account || !account.active) {
      return { ok: false, error: 'Tài khoản không tồn tại hoặc đã bị khóa' };
    }

    const valid = await verifyPassword(password, account.salt, account.passwordHash);
    if (!valid) return { ok: false, error: 'Mật khẩu không đúng' };

    await db.accounts.update(account.username, { lastLoginAt: new Date().toISOString() });
    const effectiveDeptScope = account.departmentScope ?? getDepartmentScope(account.role);
    const s: SessionUser = {
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      departmentScope: effectiveDeptScope
    };
    persistSession(s);

    // Ghi nhận Transaction Đăng nhập
    logUserAction({
      username: account.username,
      displayName: account.displayName,
      role: account.role,
      actionType: 'AUTH_LOGIN',
      targetEntity: 'Hệ thống SmartHR',
      details: `Đăng nhập thành công với vai trò ${account.role} (Phạm vi: ${effectiveDeptScope ?? 'Toàn công ty'})`
    }).catch(console.error);

    return { ok: true };
  }, []);

  const logout = useCallback(() => {
    if (session) {
      logUserAction({
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        actionType: 'AUTH_LOGOUT',
        targetEntity: 'Hệ thống SmartHR',
        details: 'Đăng xuất khỏi hệ thống'
      }).catch(console.error);
    }
    persistSession(null);
  }, [session]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }> => {
    if (!session) return { ok: false, error: 'Chưa đăng nhập' };
    if (newPassword.length < 3) return { ok: false, error: 'Mật khẩu mới phải tối thiểu 3 ký tự' };

    const account = await db.accounts.get(session.username);
    if (!account) return { ok: false, error: 'Không tìm thấy tài khoản' };

    const valid = await verifyPassword(currentPassword, account.salt, account.passwordHash);
    if (!valid) return { ok: false, error: 'Mật khẩu hiện tại không đúng' };

    const salt = generateSalt();
    await db.accounts.update(session.username, {
      salt,
      passwordHash: await hashPassword(newPassword, salt),
    });

    logUserAction({
      username: session.username,
      displayName: session.displayName,
      role: session.role,
      actionType: 'UPDATE_USER_NAME',
      targetEntity: session.username,
      details: 'Người dùng đã tự thay đổi mật khẩu tài khoản'
    }).catch(console.error);

    return { ok: true };
  }, [session]);

  const createAccount = useCallback(async (
    username: string,
    displayName: string,
    role: RoleType,
    password: string = '123',
    departmentScope: string | null = null
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!makeHasPermission(session?.role ?? null, rolePermissions)('MANAGE_USERS') && !makeHasPermission(session?.role ?? null, rolePermissions)('SYSTEM_SETTINGS')) {
      return { ok: false, error: 'Chỉ System Admin mới có quyền tạo tài khoản' };
    }
    const uname = username.trim().toLowerCase();
    if (!uname) return { ok: false, error: 'Tên đăng nhập không được để trống' };
    const pass = password.trim() || '123';
    const existing = await db.accounts.get(uname);
    if (existing) return { ok: false, error: `Tài khoản "${uname}" đã tồn tại` };

    const salt = generateSalt();
    const account: IAccount = {
      username: uname,
      displayName: displayName.trim() || uname,
      role,
      departmentScope: departmentScope ?? getDepartmentScope(role),
      salt,
      passwordHash: await hashPassword(pass, salt),
      active: true,
      activeFlag: 1,
      createdAt: new Date().toISOString(),
    };
    await db.accounts.put(account);

    if (session) {
      logUserAction({
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        actionType: 'CREATE_USER',
        targetEntity: uname,
        details: `Tạo mới tài khoản "${uname}" (${account.displayName}) với vai trò ${role} (Mật khẩu khởi tạo: 123)`
      }).catch(console.error);
    }

    return { ok: true };
  }, [session, rolePermissions]);

  const updateAccountProfile = useCallback(async (
    username: string,
    updates: { displayName?: string; role?: RoleType; departmentScope?: string | null; active?: boolean }
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!makeHasPermission(session?.role ?? null, rolePermissions)('MANAGE_USERS') && !makeHasPermission(session?.role ?? null, rolePermissions)('SYSTEM_SETTINGS')) {
      return { ok: false, error: 'Chỉ System Admin mới có quyền chỉnh sửa thông tin tài khoản' };
    }

    const account = await db.accounts.get(username);
    if (!account) return { ok: false, error: 'Không tìm thấy tài khoản để cập nhật' };

    const patch: any = {};
    const logDetails: string[] = [];

    if (updates.displayName !== undefined && updates.displayName.trim() && updates.displayName !== account.displayName) {
      patch.displayName = updates.displayName.trim();
      logDetails.push(`Đổi tên hiển thị từ "${account.displayName}" -> "${updates.displayName.trim()}"`);
    }

    if (updates.role !== undefined && updates.role !== account.role) {
      patch.role = updates.role;
      logDetails.push(`Đổi vai trò từ "${account.role}" -> "${updates.role}"`);
    }

    if (updates.departmentScope !== undefined && updates.departmentScope !== account.departmentScope) {
      patch.departmentScope = updates.departmentScope;
      logDetails.push(`Đổi phạm vi phòng ban -> "${updates.departmentScope ?? 'Toàn công ty'}"`);
    }

    if (updates.active !== undefined && updates.active !== account.active) {
      patch.active = updates.active;
      patch.activeFlag = updates.active ? 1 : 0;
      logDetails.push(`${updates.active ? 'Mở khóa' : 'Khóa'} tài khoản`);
    }

    if (Object.keys(patch).length === 0) {
      return { ok: true };
    }

    await db.accounts.update(username, patch);

    // Cập nhật session nếu chính là user hiện hành
    if (session && session.username === username) {
      const newSession: SessionUser = {
        ...session,
        displayName: patch.displayName ?? session.displayName,
        role: patch.role ?? session.role,
        departmentScope: patch.departmentScope !== undefined ? patch.departmentScope : session.departmentScope
      };
      persistSession(newSession);
    }

    if (session && logDetails.length > 0) {
      logUserAction({
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        actionType: updates.displayName ? 'UPDATE_USER_NAME' : updates.role ? 'UPDATE_USER_ROLE' : 'TOGGLE_USER_ACTIVE',
        targetEntity: username,
        details: `Cập nhật tài khoản "${username}": ${logDetails.join('; ')}`
      }).catch(console.error);
    }

    return { ok: true };
  }, [session, rolePermissions]);

  const refreshPermissions = async () => {
    const entry = await db.settings.get('systemSettings');
    if (entry?.value) {
      setSystemSettings(entry.value as ISystemSettings);
      localStorage.setItem('smarthr_settings', JSON.stringify(entry.value));
    }
  };

  const currentDeptScope = session?.departmentScope ?? (currentRole ? getDepartmentScope(currentRole) : null);

  return (
    <AuthContext.Provider
      value={{
        session,
        login,
        logout,
        changePassword,
        createAccount,
        updateAccountProfile,
        currentRole,
        departmentScope: currentDeptScope,
        hasPermission,
        rolePermissions,
        systemSettings,
        refreshPermissions,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
