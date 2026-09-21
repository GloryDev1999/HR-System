import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { RoleType, ISystemSettings, SessionUser } from '../types';
import { DEFAULT_SETTINGS } from '../lib/defaultSettings';
import { supabase } from '../lib/supabaseClient';
import { getSetting } from '../lib/tables';
import { logUserAction } from '../services/audit-log-service';

interface AuthContextType {
  /** Phiên đăng nhập hiện tại; null = chưa đăng nhập */
  session: SessionUser | null;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ ok: boolean; error?: string }>;
  resetUserPassword: (username: string, newPassword?: string) => Promise<{ ok: boolean; error?: string }>;
  unlockUser: (username: string) => Promise<{ ok: boolean; error?: string }>;
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

/** Tài khoản mặc định khởi tạo lần đầu */
export const DEFAULT_ADMIN_USERNAME = 'kieu';

/**
 * Email tổng hợp cho Supabase Auth từ username nội bộ.
 * 6 user tạo 1 lần trong Dashboard Authentication với email này:
 * kieu@hr.os, hoa@hr.os, vinh@hr.os,
 * nguyetanh@hr.os, han@hr.os, glory@hr.os
 */
export const usernameToEmail = (username: string) => {
  const u = username.trim().toLowerCase();
  // Cho phép nhập cả username (kieu) lẫn full email (kieu@hr.os)
  return u.includes('@') ? u : `${u}@hr.os`;
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

interface ProfileRow {
  id: string;
  username: string;
  display_name: string;
  role: RoleType;
  department_scope: string | null;
  active: boolean;
  is_locked: boolean;
}

async function fetchMyProfile(userId: string): Promise<ProfileRow | null> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) {
    console.warn('[Auth] fetch profile', error.message);
    return null;
  }
  return (data as ProfileRow | null) ?? null;
}

function toSession(p: ProfileRow): SessionUser {
  return {
    username: p.username,
    displayName: p.display_name,
    role: p.role,
    departmentScope: p.department_scope ?? getDepartmentScope(p.role),
  };
}

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

  // Khôi phục phiên Supabase + nạp profile
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      const user = data.session?.user;
      if (user) {
        const p = await fetchMyProfile(user.id);
        if (alive && p && p.active && !p.is_locked) setSession(toSession(p));
        else if (alive && p && (!p.active || p.is_locked)) {
          await supabase.auth.signOut();
          setSession(null);
        }
      }
    })();
    const { data: sub } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (event === 'SIGNED_OUT' || !newSession?.user) {
        if (alive) setSession(null);
        return;
      }
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
        const p = await fetchMyProfile(newSession.user.id);
        if (alive && p && p.active && !p.is_locked) setSession(toSession(p));
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

  const login = useCallback(async (username: string, password: string): Promise<{ ok: boolean; error?: string }> => {
    let uname = username.trim().toLowerCase();
    if (!uname || !password) return { ok: false, error: 'Vui lòng nhập tên đăng nhập và mật khẩu' };

    // Hỗ trợ gõ cả Kiều có dấu hoặc kieu không dấu
    if (uname === 'kiều') uname = 'kieu';

    const { data, error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(uname),
      password,
    });
    if (error || !data.user) {
      return { ok: false, error: 'Tên đăng nhập hoặc mật khẩu không đúng' };
    }

    const p = await fetchMyProfile(data.user.id);
    if (!p) {
      await supabase.auth.signOut();
      return { ok: false, error: 'Tài khoản chưa có hồ sơ (profiles) — liên hệ System Admin' };
    }
    if (p.is_locked || !p.active) {
      await supabase.auth.signOut();
      return {
        ok: false,
        error: 'User đã bị khóa! vui lòng Liên hệ phòng nhân sự để được mở khóa user'
      };
    }

    const s = toSession(p);
    setSession(s);
    await supabase.from('profiles').update({ last_login_at: new Date().toISOString() }).eq('id', data.user.id);

    // Ghi nhận Transaction Đăng nhập
    logUserAction({
      username: p.username,
      displayName: p.display_name,
      role: p.role,
      actionType: 'AUTH_LOGIN',
      targetEntity: 'Hệ thống SmartHR',
      details: `Đăng nhập thành công với vai trò ${p.role} (Phạm vi: ${s.departmentScope ?? 'Toàn công ty'})`
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
    const { error: reErr } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(session.username),
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
    _username: string,
    _newPassword: string = '123'
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!makeHasPermission(session?.role ?? null, rolePermissions)('MANAGE_USERS') && !makeHasPermission(session?.role ?? null, rolePermissions)('SYSTEM_SETTINGS')) {
      return { ok: false, error: 'Chỉ System Admin mới có quyền đặt lại mật khẩu' };
    }
    // Supabase Auth: anon key không được đổi mật khẩu user khác (cần service_role
    // phía server). Admin đặt lại trong Dashboard Authentication → Users.
    // Ở đây chỉ mở khóa cờ lock để user tự đổi pass sau khi đăng nhập.
    const uname = _username.trim().toLowerCase();
    const { data: target } = await supabase.from('profiles').select('id').eq('username', uname).maybeSingle();
    if (!target) return { ok: false, error: 'Không tìm thấy tài khoản' };
    const { error } = await supabase
      .from('profiles')
      .update({ is_locked: false, active: true, failed_login_attempts: 0 })
      .eq('id', (target as any).id);
    if (error) return { ok: false, error: error.message };

    if (session) {
      logUserAction({
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        actionType: 'UPDATE_USER_NAME',
        targetEntity: uname,
        details: `Mở khóa tài khoản "${uname}". Đặt lại mật khẩu thực hiện trong Supabase Dashboard → Authentication → Users.`
      }).catch(console.error);
    }

    return { ok: true };
  }, [session, rolePermissions]);

  const unlockUser = useCallback(async (
    username: string
  ): Promise<{ ok: boolean; error?: string }> => {
    if (!makeHasPermission(session?.role ?? null, rolePermissions)('MANAGE_USERS') && !makeHasPermission(session?.role ?? null, rolePermissions)('SYSTEM_SETTINGS')) {
      return { ok: false, error: 'Chỉ System Admin mới có quyền mở khóa tài khoản' };
    }
    const uname = username.trim().toLowerCase();
    const { data: target } = await supabase.from('profiles').select('id').eq('username', uname).maybeSingle();
    if (!target) return { ok: false, error: 'Không tìm thấy tài khoản' };

    const { error } = await supabase
      .from('profiles')
      .update({ is_locked: false, active: true, failed_login_attempts: 0 })
      .eq('id', (target as any).id);
    if (error) return { ok: false, error: error.message };

    if (session) {
      logUserAction({
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        actionType: 'TOGGLE_USER_ACTIVE',
        targetEntity: uname,
        details: `Mở khóa và reset số lần nhập sai mật khẩu về 0 cho tài khoản "${uname}"`
      }).catch(console.error);
    }

    return { ok: true };
  }, [session, rolePermissions]);

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
    const { data: existing } = await supabase.from('profiles').select('id').eq('username', uname).maybeSingle();
    if (existing) return { ok: false, error: `Tài khoản "${uname}" đã tồn tại` };

    // signUp tự đăng nhập user mới → xong việc phải signOut để admin đăng nhập lại.
    // (Tạo user hàng loạt nên làm trong Dashboard Authentication.)
    const { data, error } = await supabase.auth.signUp({
      email: usernameToEmail(uname),
      password: pass,
    });
    if (error || !data.user) {
      return { ok: false, error: error?.message || 'Tạo tài khoản thất bại' };
    }
    const scope = departmentScope ?? getDepartmentScope(role);
    await supabase.from('profiles').update({
      username: uname,
      display_name: displayName.trim() || uname,
      role,
      department_scope: scope,
      active: true,
    }).eq('id', data.user.id);
    await supabase.auth.signOut();

    if (session) {
      logUserAction({
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        actionType: 'CREATE_USER',
        targetEntity: uname,
        details: `Tạo mới tài khoản "${uname}" với vai trò ${role}. Vui lòng đăng nhập lại tài khoản admin.`
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

    const { data: account } = await supabase.from('profiles').select('*').eq('username', username).maybeSingle();
    if (!account) return { ok: false, error: 'Không tìm thấy tài khoản để cập nhật' };
    const acc = account as any;

    const patch: any = {};
    const logDetails: string[] = [];

    if (updates.displayName !== undefined && updates.displayName.trim() && updates.displayName !== acc.display_name) {
      patch.display_name = updates.displayName.trim();
      logDetails.push(`Đổi tên hiển thị từ "${acc.display_name}" -> "${updates.displayName.trim()}"`);
    }

    if (updates.role !== undefined && updates.role !== acc.role) {
      patch.role = updates.role;
      logDetails.push(`Đổi vai trò từ "${acc.role}" -> "${updates.role}"`);
    }

    if (updates.departmentScope !== undefined && updates.departmentScope !== acc.department_scope) {
      patch.department_scope = updates.departmentScope;
      logDetails.push(`Đổi phạm vi phòng ban -> "${updates.departmentScope ?? 'Toàn công ty'}"`);
    }

    if (updates.active !== undefined && updates.active !== acc.active) {
      patch.active = updates.active;
      if (!updates.active) patch.is_locked = true;
      logDetails.push(`${updates.active ? 'Mở khóa' : 'Khóa'} tài khoản`);
    }

    if (Object.keys(patch).length === 0) {
      return { ok: true };
    }

    const { error } = await supabase.from('profiles').update(patch).eq('id', acc.id);
    if (error) return { ok: false, error: error.message };

    // Cập nhật session nếu chính là user hiện hành
    if (session && session.username === username) {
      const newSession: SessionUser = {
        ...session,
        displayName: patch.display_name ?? session.displayName,
        role: patch.role ?? session.role,
        departmentScope: patch.department_scope !== undefined ? patch.department_scope : session.departmentScope
      };
      setSession(newSession);
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
