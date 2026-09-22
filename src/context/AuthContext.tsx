import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { RoleType, ISystemSettings, SessionUser } from '../types';
import { DEFAULT_SETTINGS } from '../lib/defaultSettings';
import { supabase } from '../lib/supabaseClient';
import { getSetting } from '../lib/tables';
import { logUserAction } from '../services/audit-log-service';
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess, lockoutMessage } from '../services/login-guard';

interface AuthContextType {
  /** Phiên đăng nhập hiện tại; null = chưa đăng nhập */
  session: SessionUser | null;
  login: (emailOrUsername: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ ok: boolean; error?: string }>;
  resetUserPassword: (email: string, newPassword?: string) => Promise<{ ok: boolean; error?: string }>;
  unlockUser: (email: string) => Promise<{ ok: boolean; error?: string }>;
  createAccount: (email: string, displayName: string, role: RoleType, password?: string, departmentScope?: string | null) => Promise<{ ok: boolean; error?: string }>;
  updateAccountProfile: (email: string, updates: { displayName?: string; role?: RoleType; departmentScope?: string | null; active?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  currentRole: RoleType | null;
  departmentScope: string | null; // null for company-wide, or 'WH', 'Production', 'QC'
  hasPermission: (action: string) => boolean;
  rolePermissions: ISystemSettings['rolePermissions'];
  systemSettings: ISystemSettings;
  refreshPermissions: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** Tài khoản mẫu vận hành */
export const DEFAULT_ADMIN_USERNAME = 'vinh@leggett.com';

/**
 * Email đăng nhập chuẩn Supabase Auth: vinh@leggett.com, hoa@leggett.com...
 * Chấp nhận cả username rút gọn (vinh -> vinh@leggett.com).
 */
export const usernameToEmail = (input: string) => {
  const v = input.trim().toLowerCase();
  return v.includes('@') ? v : `${v}@leggett.com`;
};

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

/** Dựng SessionUser từ supabase user (role/scope trong app_metadata). */
function sessionFromUser(u: any): SessionUser | null {
  const md = u?.app_metadata ?? {};
  if (!md.role) return null;
  const email = String(u.email || '');
  const username = md.username || email.split('@')[0] || email;
  return {
    username,
    displayName: md.display_name || username,
    role: md.role as RoleType,
    departmentScope: (md.department_scope as string | null) ?? getDepartmentScope(md.role as RoleType),
  };
}

const DASHBOARD_GUIDE =
  'Quản lý user (đổi vai trò, khóa/mở, reset mật khẩu người khác) thực hiện trong Supabase Dashboard → Authentication → Users (sửa App Metadata), hoặc SQL: UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || \'{...}\'::jsonb WHERE email = \'...\'.';

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<SessionUser | null>(null);

  // RBAC từ Supabase app_settings (fallback DEFAULT khi chưa có)
  const [systemSettings, setSystemSettings] = useState<ISystemSettings>(DEFAULT_SETTINGS);

  const loadSettings = useCallback(async () => {
    try {
      const val = await getSetting<ISystemSettings>('systemSettings');
      if (val) setSystemSettings(val);
    } catch {
      // Chưa đăng nhập / chưa có settings → giữ DEFAULT
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    // Realtime settings: đổi ma trận quyền là mọi máy cập nhật ngay
    const ch = supabase
      .channel('app-settings')
      .on('postgres_changes' as never, { event: '*', schema: 'public', table: 'app_settings' } as never, (() => void loadSettings()) as never)
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [loadSettings]);

  // Khôi phục phiên Supabase
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      const s = data.session?.user ? sessionFromUser(data.session.user) : null;
      if (alive) setSession(s);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (event === 'SIGNED_OUT' || !newSession?.user) {
        if (alive) setSession(null);
        return;
      }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
        if (alive) setSession(sessionFromUser(newSession.user));
      }
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const currentRole = session?.role ?? null;
  const rolePermissions = systemSettings?.rolePermissions || DEFAULT_SETTINGS.rolePermissions;
  const hasPermission = useCallback(
    makeHasPermission(currentRole, rolePermissions),
    [currentRole, rolePermissions]
  );

  const login = useCallback(async (emailOrUsername: string, password: string): Promise<{ ok: boolean; error?: string }> => {
    if (!emailOrUsername.trim() || !password) return { ok: false, error: 'Vui lòng nhập email đăng nhập và mật khẩu' };

    // Lớp chống dò mật khẩu phía client (server Supabase Auth vẫn rate-limit độc lập)
    const gate = checkLoginAllowed(emailOrUsername);
    if (!gate.allowed) {
      return { ok: false, error: lockoutMessage(gate.retryAfterSec) };
    }

    const email = usernameToEmail(emailOrUsername);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      recordLoginFailure(emailOrUsername);
      return { ok: false, error: 'Tên đăng nhập hoặc mật khẩu không đúng' };
    }
    recordLoginSuccess(emailOrUsername);

    const s = sessionFromUser(data.user);
    if (!s) {
      await supabase.auth.signOut();
      return { ok: false, error: 'Tài khoản chưa được gán vai trò (app_metadata.role) — liên hệ System Admin' };
    }
    setSession(s);

    // Ghi nhận Transaction Đăng nhập
    logUserAction({
      username: s.username,
      displayName: s.displayName,
      role: s.role,
      actionType: 'AUTH_LOGIN',
      targetEntity: 'Hệ thống SmartHR',
      details: `Đăng nhập thành công với vai trò ${s.role} (Phạm vi: ${s.departmentScope ?? 'Toàn công ty'})`
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
    void supabase.auth.signOut();
    setSession(null);
  }, [session]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string): Promise<{ ok: boolean; error?: string }> => {
    if (!session) return { ok: false, error: 'Chưa đăng nhập' };
    if (newPassword.length < 6) return { ok: false, error: 'Mật khẩu mới phải tối thiểu 6 ký tự (chính sách Supabase Auth)' };

    // Xác thực lại mật khẩu hiện tại bằng cách sign-in lại
    const { data: udata } = await supabase.auth.getUser();
    const { error: reErr } = await supabase.auth.signInWithPassword({
      email: udata.user?.email || '',
      password: currentPassword,
    });
    if (reErr) return { ok: false, error: 'Mật khẩu hiện tại không đúng' };

    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return { ok: false, error: error.message };

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

  const resetUserPassword = useCallback(async (
    email: string,
    newPassword: string = '123456'
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!makeHasPermission(session?.role ?? null, rolePermissions)('MANAGE_USERS') && !makeHasPermission(session?.role ?? null, rolePermissions)('SYSTEM_SETTINGS')) {
      return { ok: false, error: 'Chỉ System Admin mới có quyền đặt lại mật khẩu' };
    }
    const mail = email.trim().toLowerCase();
    if (!mail.includes('@')) return { ok: false, error: 'Email không hợp lệ' };
    if (newPassword.trim().length < 6) return { ok: false, error: 'Mật khẩu mới phải tối thiểu 6 ký tự' };

    // Gọi Edge Function admin-user (service_role sống phía server, đã gate AD System).
    const { data, error } = await supabase.functions.invoke('admin-user', {
      body: { action: 'reset_password', email: mail, newPassword: newPassword.trim() },
    });
    if (error) return { ok: false, error: error.message };
    if ((data as any)?.error) return { ok: false, error: (data as any).error as string };

    if (session) {
      logUserAction({
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        actionType: 'RESET_PASSWORD',
        targetEntity: mail,
        details: `Cấp lại mật khẩu cho "${mail}" trực tiếp từ frontend (Edge Function admin-user)`
      }).catch(console.error);
    }

    return { ok: true };
  }, [session, rolePermissions]);

  const unlockUser = useCallback(async (
    email: string
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!makeHasPermission(session?.role ?? null, rolePermissions)('MANAGE_USERS') && !makeHasPermission(session?.role ?? null, rolePermissions)('SYSTEM_SETTINGS')) {
      return { ok: false, error: 'Chỉ System Admin mới có quyền mở khóa tài khoản' };
    }
    const { data, error } = await supabase.functions.invoke('admin-user', {
      body: { action: 'unban', email: email.trim().toLowerCase() },
    });
    if (error) return { ok: false, error: error.message };
    if ((data as any)?.error) return { ok: false, error: (data as any).error as string };

    if (session) {
      logUserAction({
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        actionType: 'TOGGLE_USER_ACTIVE',
        targetEntity: email,
        details: `Gỡ ban tài khoản "${email}" (Edge Function admin-user)`
      }).catch(console.error);
    }

    return { ok: true };
  }, [session, rolePermissions]);

  const createAccount = useCallback(async (
    email: string,
    displayName: string,
    _role: RoleType,
    password: string = '123456',
    _departmentScope: string | null = null
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!makeHasPermission(session?.role ?? null, rolePermissions)('MANAGE_USERS') && !makeHasPermission(session?.role ?? null, rolePermissions)('SYSTEM_SETTINGS')) {
      return { ok: false, error: 'Chỉ System Admin mới có quyền tạo tài khoản' };
    }
    const mail = email.trim().toLowerCase();
    if (!mail || !mail.includes('@')) return { ok: false, error: 'Email không hợp lệ' };
    const pass = password.trim() || '123456';

    // signUp tự đăng nhập user mới → xong việc phải signOut để admin đăng nhập lại.
    // Vai trò (app_metadata.role) GÁN SAU trong Dashboard/SQL (xem DASHBOARD_GUIDE).
    const { data, error } = await supabase.auth.signUp({
      email: mail,
      password: pass,
      options: { data: { display_name: displayName.trim() || mail } },
    });
    if (error || !data.user) {
      return { ok: false, error: error?.message || 'Tạo tài khoản thất bại' };
    }
    await supabase.auth.signOut();
    void _role;
    void _departmentScope;

    if (session) {
      logUserAction({
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        actionType: 'CREATE_USER',
        targetEntity: mail,
        details: `Tạo mới tài khoản "${mail}". Cần gán vai trò trong Dashboard (App Metadata) rồi đăng nhập lại tài khoản admin.`
      }).catch(console.error);
    }

    return { ok: true };
  }, [session, rolePermissions]);

  const updateAccountProfile = useCallback(async (
    _email: string,
    _updates: { displayName?: string; role?: RoleType; departmentScope?: string | null; active?: boolean }
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!makeHasPermission(session?.role ?? null, rolePermissions)('MANAGE_USERS') && !makeHasPermission(session?.role ?? null, rolePermissions)('SYSTEM_SETTINGS')) {
      return { ok: false, error: 'Chỉ System Admin mới có quyền chỉnh sửa thông tin tài khoản' };
    }
    return { ok: false, error: DASHBOARD_GUIDE };
  }, [session, rolePermissions]);

  const refreshPermissions = async () => {
    await loadSettings();
  };

  const currentDeptScope = session?.departmentScope ?? (currentRole ? getDepartmentScope(currentRole) : null);

  return (
    <AuthContext.Provider
      value={{
        session,
        login,
        logout,
        changePassword,
        resetUserPassword,
        unlockUser,
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
