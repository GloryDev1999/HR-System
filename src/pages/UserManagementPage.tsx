import React, { useState, useMemo } from 'react';
import { 
  Users, 
  ShieldCheck, 
  UserPlus, 
  Edit3, 
  Check, 
  X, 
  Activity, 
  Filter, 
  RefreshCw, 
  Search, 
  Lock, 
  CheckCircle2, 
  XCircle,
  Building2,
  Calendar,
  Layers,
  ArrowUpDown,
  KeyRound,
  Unlock
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { IAccount, RoleType, AuditActionType, IUserAuditLog } from '../types';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';

export const UserManagementPage: React.FC = () => {
  const { session, createAccount, updateAccountProfile, resetUserPassword, unlockUser, hasPermission } = useAuth();
  const { success, error, warning } = useToast();
  const { confirm } = useModal();

  const [activeTab, setActiveTab] = useState<'users' | 'audit'>('users');

  // Queries
  const accounts = useLiveQuery(() => db.accounts.toArray(), []) || [];
  const auditLogs = useLiveQuery(() => db.userAuditLogs.orderBy('timestamp').reverse().limit(200).toArray(), []) || [];

  // Edit user state
  const [editingUsername, setEditingUsername] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editRole, setEditRole] = useState<RoleType>('HR Admin');
  const [editDeptScope, setEditDeptScope] = useState<string>('');

  // New user modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<RoleType>('Warehouse Admin');
  const [newDeptScope, setNewDeptScope] = useState<string>('WH');

  // Audit filters
  const [auditUserFilter, setAuditUserFilter] = useState<string>('ALL');
  const [auditActionFilter, setAuditActionFilter] = useState<string>('ALL');
  const [auditSearchQuery, setAuditSearchQuery] = useState('');

  // Reset password state
  const [resetModalUser, setResetModalUser] = useState<IAccount | null>(null);
  const [newPasswordInput, setNewPasswordInput] = useState('123');

  // Roles available
  const availableRoles: RoleType[] = [
    'AD System',
    'HR Manager',
    'HR Admin',
    'Warehouse Admin',
    'Production Admin',
    'QC Admin'
  ];

  const handleOpenResetPassword = (acc: IAccount) => {
    setResetModalUser(acc);
    setNewPasswordInput('123');
  };

  const handleConfirmResetPassword = async () => {
    if (!resetModalUser) return;
    if (!newPasswordInput.trim()) {
      warning('Thiếu thông tin', 'Mật khẩu không được để trống.');
      return;
    }
    const res = await resetUserPassword(resetModalUser.username, newPasswordInput.trim());
    if (res.ok) {
      success('Đặt lại mật khẩu thành công', `Đã đổi mật khẩu cho tài khoản "${resetModalUser.username}" thành "${newPasswordInput.trim()}" và mở khóa tài khoản.`);
      setResetModalUser(null);
    } else {
      error('Lỗi đặt lại mật khẩu', res.error || 'Thao tác không thành công.');
    }
  };

  const handleDirectUnlock = async (acc: IAccount) => {
    const ok = await confirm({
      title: 'Mở khóa tài khoản',
      message: `Mở khóa cho tài khoản "${acc.displayName}" (${acc.username}) và đặt lại số lần nhập sai về 0?`,
      confirmText: 'Mở khóa ngay',
      cancelText: 'Hủy',
      type: 'info'
    });
    if (ok) {
      const res = await unlockUser(acc.username);
      if (res.ok) {
        success('Mở khóa thành công', `Tài khoản "${acc.username}" đã được mở khóa và có thể đăng nhập bình thường.`);
      } else {
        error('Lỗi', res.error || 'Thao tác không thành công.');
      }
    }
  };

  const handleStartEdit = (acc: IAccount) => {
    setEditingUsername(acc.username);
    setEditDisplayName(acc.displayName);
    setEditRole(acc.role);
    setEditDeptScope(acc.departmentScope || '');
  };

  const handleCancelEdit = () => {
    setEditingUsername(null);
  };

  const handleSaveEdit = async (username: string) => {
    if (!editDisplayName.trim()) {
      warning('Thiếu thông tin', 'Tên hiển thị không được để trống.');
      return;
    }

    const res = await updateAccountProfile(username, {
      displayName: editDisplayName.trim(),
      role: editRole,
      departmentScope: editDeptScope ? editDeptScope : null
    });

    if (res.ok) {
      success('Cập nhật thành công', `Đã lưu thay đổi cho tài khoản "${username}".`);
      setEditingUsername(null);
    } else {
      error('Lỗi cập nhật', res.error || 'Không thể lưu thay đổi.');
    }
  };

  const handleToggleActive = async (acc: IAccount) => {
    if (acc.username === session?.username) {
      warning('Không thể thao tác', 'Bạn không thể tự khóa tài khoản đang đăng nhập của chính mình.');
      return;
    }

    const nextState = !acc.active;
    const ok = await confirm({
      title: nextState ? 'Mở khóa tài khoản' : 'Khóa tài khoản',
      message: nextState 
        ? `Bạn có chắc chắn muốn mở khóa cho tài khoản "${acc.displayName}" (${acc.username})?`
        : `Tài khoản "${acc.displayName}" (${acc.username}) sẽ không thể đăng nhập vào hệ thống sau khi khóa. Tiếp tục?`,
      type: nextState ? 'info' : 'warning',
      confirmText: nextState ? 'Mở khóa' : 'Khóa tài khoản',
      cancelText: 'Hủy'
    });

    if (ok) {
      const res = await updateAccountProfile(acc.username, { active: nextState });
      if (res.ok) {
        success('Thành công', `Đã ${nextState ? 'mở khóa' : 'khóa'} tài khoản "${acc.username}".`);
      } else {
        error('Lỗi', res.error || 'Thao tác không thành công.');
      }
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim()) {
      warning('Thiếu thông tin', 'Vui lòng nhập tên đăng nhập.');
      return;
    }

    const uname = newUsername.trim().toLowerCase();
    const dname = newDisplayName.trim() || newUsername.trim();

    const res = await createAccount(uname, dname, newRole, '123', newDeptScope || null);
    if (res.ok) {
      success('Tạo tài khoản thành công', `Tài khoản "${uname}" đã được tạo với mật khẩu khởi tạo mặc định là "123".`);
      setShowAddModal(false);
      setNewUsername('');
      setNewDisplayName('');
      setNewRole('Warehouse Admin');
      setNewDeptScope('WH');
    } else {
      error('Lỗi tạo tài khoản', res.error || 'Không thể tạo tài khoản mới.');
    }
  };

  // Filtered Audit Logs
  const filteredAuditLogs = useMemo(() => {
    return auditLogs.filter(log => {
      if (auditUserFilter !== 'ALL' && log.username !== auditUserFilter) return false;
      if (auditActionFilter !== 'ALL' && log.actionType !== auditActionFilter) return false;
      if (auditSearchQuery.trim()) {
        const q = auditSearchQuery.toLowerCase();
        const matchTarget = log.targetEntity?.toLowerCase().includes(q);
        const matchDetails = log.details?.toLowerCase().includes(q);
        const matchUser = log.displayName?.toLowerCase().includes(q) || log.username.toLowerCase().includes(q);
        if (!matchTarget && !matchDetails && !matchUser) return false;
      }
      return true;
    });
  }, [auditLogs, auditUserFilter, auditActionFilter, auditSearchQuery]);

  const getActionBadge = (action: AuditActionType) => {
    switch (action) {
      case 'AUTH_LOGIN':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">Đăng Nhập</span>;
      case 'AUTH_LOGOUT':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-200">Đăng Xuất</span>;
      case 'ASSIGN_SHIFT':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-800 border border-indigo-200">Sắp Xếp Ca</span>;
      case 'UPDATE_RATE_NS':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">Tỷ Lệ Năng Suất</span>;
      case 'UPDATE_RATE_CL':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-teal-100 text-teal-800 border border-teal-200">Tỷ Lệ Chất Lượng</span>;
      case 'CREATE_USER':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-200">Tạo User</span>;
      case 'UPDATE_USER_NAME':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-100 text-sky-800 border border-sky-200">Đổi Tên User</span>;
      case 'UPDATE_USER_ROLE':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-200">Đổi Vai Trò</span>;
      case 'TOGGLE_USER_ACTIVE':
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-100 text-orange-800 border border-orange-200">Khóa/Mở User</span>;
      default:
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-100 text-gray-700">{action}</span>;
    }
  };

  return (
    <div className="p-6 w-full space-y-6 flex-1 flex flex-col font-sans">
      {/* Top Banner */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-orange-500" />
            <span>Quản Lý Người Dùng Hệ Thống & Nhật Ký Hoạt Động (User Management & Audit Trail)</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Quản trị viên có thể xem danh sách 6 tài khoản phân quyền theo vai trò, thêm user mới, đổi tên hiển thị và theo dõi chi tiết toàn bộ transaction hoạt động. Mật khẩu khởi tạo mặc định là <b>123</b>.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-bold text-xs rounded-xl shadow-sm hover:from-orange-600 hover:to-amber-600 transition"
          >
            <UserPlus className="w-4 h-4" />
            <span>Thêm User Mới</span>
          </button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('users')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'users'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Users className="w-4 h-4 text-orange-400" />
          <span>Danh Sách Tài Khoản & Phân Quyền ({accounts.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('audit')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'audit'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Activity className="w-4 h-4 text-emerald-400" />
          <span>Nhật Ký Giao Dịch & Hoạt Động (Transaction Logs)</span>
        </button>
      </div>

      {/* TAB 1: DANH SÁCH USER */}
      {activeTab === 'users' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
          <div className="p-4 border-b border-slate-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-slate-50/50">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Danh Mục Tài Khoản Vận Hành Trong Hệ Thống</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Các tài khoản được phân bổ theo 6 vai trò chuẩn: Master Host (Kieu), HR Client (Hoa), WH-Admin (Vinh), QC-Admin (Nguyet Anh), Prd-Admin (Han), Technical (Glory).
              </p>
            </div>
            <div className="text-xs text-slate-500 bg-amber-50 text-amber-800 px-3 py-1 rounded-xl border border-amber-200 flex items-center gap-1.5 font-medium">
              <Lock className="w-3.5 h-3.5 text-amber-600" />
              <span>Chính sách bảo mật: Không thể xem hoặc thay đổi mật khẩu của user khác tại bảng này.</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-100 text-slate-700 font-bold">
                  <th className="py-3 px-4">Tên Đăng Nhập</th>
                  <th className="py-3 px-4">Tên Hiển Thị (Display Name)</th>
                  <th className="py-3 px-4">Vai Trò (Role)</th>
                  <th className="py-3 px-4">Phạm Vi Bộ Phận</th>
                  <th className="py-3 px-4">Trạng Thái</th>
                  <th className="py-3 px-4 text-center">Thao Tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {accounts.map(acc => {
                  const isEditing = editingUsername === acc.username;
                  return (
                    <tr key={acc.username} className={`hover:bg-slate-50/80 transition ${!acc.active ? 'bg-rose-50/30' : ''}`}>
                      {/* Username */}
                      <td className="py-3 px-4 font-mono font-bold text-slate-900">
                        {acc.username}
                        {acc.username === session?.username && (
                          <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-700 border border-orange-200">
                            Đang đăng nhập
                          </span>
                        )}
                      </td>

                      {/* Display Name */}
                      <td className="py-3 px-4">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editDisplayName}
                            onChange={e => setEditDisplayName(e.target.value)}
                            className="px-2 py-1 text-xs border border-orange-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 w-full max-w-[200px]"
                          />
                        ) : (
                          <div className="font-bold text-slate-800">{acc.displayName}</div>
                        )}
                      </td>

                      {/* Role */}
                      <td className="py-3 px-4">
                        {isEditing ? (
                          <select
                            value={editRole}
                            onChange={e => {
                              const r = e.target.value as RoleType;
                              setEditRole(r);
                              if (r === 'Warehouse Admin') setEditDeptScope('WH');
                              else if (r === 'QC Admin') setEditDeptScope('QC');
                              else if (r === 'Production Admin') setEditDeptScope('Production');
                              else setEditDeptScope('');
                            }}
                            className="px-2 py-1 text-xs border border-orange-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                          >
                            {availableRoles.map(r => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-slate-100 text-slate-800 border border-slate-200">
                            {acc.role}
                          </span>
                        )}
                      </td>

                      {/* Department Scope */}
                      <td className="py-3 px-4">
                        {isEditing ? (
                          <select
                            value={editDeptScope}
                            onChange={e => setEditDeptScope(e.target.value)}
                            className="px-2 py-1 text-xs border border-orange-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                          >
                            <option value="">Toàn công ty</option>
                            <option value="WH">Kho (WH)</option>
                            <option value="QC">Quản lý chất lượng (QC)</option>
                            <option value="Production">Sản xuất (Production)</option>
                          </select>
                        ) : (
                          <div className="flex items-center gap-1.5 text-slate-600 font-medium">
                            <Building2 className="w-3.5 h-3.5 text-slate-400" />
                            <span>{acc.departmentScope ? `${acc.departmentScope}` : 'Toàn công ty'}</span>
                          </div>
                        )}
                      </td>

                      {/* Active / Lock State */}
                      <td className="py-3 px-4">
                        <div className="flex flex-col gap-1">
                          {Boolean(acc.isLocked || ((acc.failedLoginAttempts || 0) >= 10)) ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-rose-100 text-rose-700 border border-rose-200">
                              <Lock className="w-3 h-3 text-rose-600" />
                              <span>Đã khóa ({acc.failedLoginAttempts || 10}/10 lần sai)</span>
                            </span>
                          ) : !acc.active ? (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600 border border-slate-200">
                              <XCircle className="w-3 h-3 text-slate-500" />
                              <span>Vô hiệu hóa</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                              <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                              <span>Hoạt động</span>
                            </span>
                          )}
                          {(acc.failedLoginAttempts ?? 0) > 0 && !acc.isLocked ? (
                            <span className="text-[10px] text-amber-600 font-semibold pl-1">
                              ⚠️ Sai {acc.failedLoginAttempts}/10 lần
                            </span>
                          ) : null}
                        </div>
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-center">
                        {isEditing ? (
                          <div className="flex items-center justify-center gap-2">
                            <button
                              onClick={() => handleSaveEdit(acc.username)}
                              className="p-1.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 shadow-sm transition"
                              title="Lưu thay đổi"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={handleCancelEdit}
                              className="p-1.5 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition"
                              title="Hủy"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-1.5 flex-wrap">
                            <button
                              onClick={() => handleStartEdit(acc)}
                              className="flex items-center gap-1 px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 font-semibold text-xs transition"
                              title="Chỉnh sửa tên và vai trò"
                            >
                              <Edit3 className="w-3 h-3 text-slate-500" />
                              <span>Sửa</span>
                            </button>

                            {Boolean(acc.isLocked || ((acc.failedLoginAttempts || 0) >= 10) || !acc.active) && (
                              <button
                                onClick={() => handleDirectUnlock(acc)}
                                className="flex items-center gap-1 px-2.5 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-lg font-bold text-xs transition"
                                title="Mở khóa tài khoản ngay lập tức"
                              >
                                <Unlock className="w-3 h-3 text-emerald-600" />
                                <span>Mở khóa</span>
                              </button>
                            )}

                            <button
                              onClick={() => handleOpenResetPassword(acc)}
                              className="flex items-center gap-1 px-2.5 py-1 bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200 rounded-lg font-bold text-xs transition"
                              title="Đặt lại mật khẩu cho tài khoản này"
                            >
                              <KeyRound className="w-3 h-3 text-amber-600" />
                              <span>Đặt lại MK</span>
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: AUDIT TRAIL / TRANSACTIONS */}
      {activeTab === 'audit' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
          {/* Filter Bar */}
          <div className="p-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50/50">
            <div className="flex flex-wrap items-center gap-2.5">
              {/* User filter */}
              <div className="flex items-center gap-1.5 text-xs text-slate-600">
                <span className="font-bold">Tài khoản:</span>
                <select
                  value={auditUserFilter}
                  onChange={e => setAuditUserFilter(e.target.value)}
                  className="px-2.5 py-1 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
                >
                  <option value="ALL">Tất cả tài khoản</option>
                  {accounts.map(a => (
                    <option key={a.username} value={a.username}>{a.displayName} ({a.username})</option>
                  ))}
                </select>
              </div>

              {/* Action filter */}
              <div className="flex items-center gap-1.5 text-xs text-slate-600">
                <span className="font-bold">Loại hành động:</span>
                <select
                  value={auditActionFilter}
                  onChange={e => setAuditActionFilter(e.target.value)}
                  className="px-2.5 py-1 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 bg-white"
                >
                  <option value="ALL">Tất cả hành động</option>
                  <option value="AUTH_LOGIN">Đăng Nhập</option>
                  <option value="AUTH_LOGOUT">Đăng Xuất</option>
                  <option value="ASSIGN_SHIFT">Sắp Xếp Ca</option>
                  <option value="UPDATE_RATE_NS">Tỷ Lệ Năng Suất</option>
                  <option value="UPDATE_RATE_CL">Tỷ Lệ Chất Lượng</option>
                  <option value="CREATE_USER">Tạo User</option>
                  <option value="UPDATE_USER_NAME">Đổi Tên User</option>
                  <option value="UPDATE_USER_ROLE">Đổi Vai Trò</option>
                  <option value="TOGGLE_USER_ACTIVE">Khóa/Mở User</option>
                </select>
              </div>

              {/* Search box */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Tìm kiếm đối tượng, chi tiết..."
                  value={auditSearchQuery}
                  onChange={e => setAuditSearchQuery(e.target.value)}
                  className="pl-8 pr-3 py-1 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 w-56 bg-white"
                />
              </div>
            </div>

            <div className="text-xs font-semibold text-slate-500">
              Hiển thị <b>{filteredAuditLogs.length}</b> / {auditLogs.length} giao dịch gần nhất
            </div>
          </div>

          {/* Audit Logs Table */}
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-slate-100 z-10">
                <tr className="border-b border-slate-200 text-slate-700 font-bold">
                  <th className="py-3 px-4 w-40">Thời Gian</th>
                  <th className="py-3 px-4 w-36">Tài Khoản</th>
                  <th className="py-3 px-4 w-32">Loại Thao Tác</th>
                  <th className="py-3 px-4 w-48">Đối Tượng Tác Động</th>
                  <th className="py-3 px-4">Nội Dung Chi Tiết Giao Dịch</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredAuditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-10 text-slate-400 italic">
                      Chưa có giao dịch hoạt động nào phù hợp với bộ lọc.
                    </td>
                  </tr>
                ) : (
                  filteredAuditLogs.map(log => {
                    const date = new Date(log.timestamp);
                    const timeStr = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                    const dateStr = date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });

                    return (
                      <tr key={log.id} className="hover:bg-slate-50/80 transition">
                        <td className="py-2.5 px-4 text-slate-500 font-mono text-[11px] whitespace-nowrap">
                          <div>{timeStr}</div>
                          <div className="text-[10px] text-slate-400">{dateStr}</div>
                        </td>

                        <td className="py-2.5 px-4 whitespace-nowrap">
                          <div className="font-bold text-slate-800">{log.displayName}</div>
                          <div className="text-[10px] text-slate-400 font-mono">@{log.username}</div>
                        </td>

                        <td className="py-2.5 px-4 whitespace-nowrap">
                          {getActionBadge(log.actionType)}
                        </td>

                        <td className="py-2.5 px-4 font-medium text-slate-700 whitespace-nowrap">
                          <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-800 font-mono text-[11px]">
                            {log.targetEntity || '—'}
                          </span>
                        </td>

                        <td className="py-2.5 px-4 text-slate-600 font-normal leading-relaxed">
                          {log.details}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL: THÊM USER MỚI */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-200">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-orange-500" />
                <span>Thêm Tài Khoản Vận Hành Mới</span>
              </h3>
              <button
                onClick={() => setShowAddModal(false)}
                className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="mt-4 space-y-4 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">Tên Đăng Nhập (Username) *</label>
                <input
                  type="text"
                  required
                  placeholder="ví dụ: hoa, vinh, nguyetanh..."
                  value={newUsername}
                  onChange={e => setNewUsername(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 text-xs font-mono"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Tên Hiển Thị (Display Name) *</label>
                <input
                  type="text"
                  required
                  placeholder="ví dụ: Hoa(Molly), Vinh(Glory)..."
                  value={newDisplayName}
                  onChange={e => setNewDisplayName(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 text-xs"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Vai Trò Hệ Thống (Role) *</label>
                <select
                  value={newRole}
                  onChange={e => {
                    const r = e.target.value as RoleType;
                    setNewRole(r);
                    if (r === 'Warehouse Admin') setNewDeptScope('WH');
                    else if (r === 'QC Admin') setNewDeptScope('QC');
                    else if (r === 'Production Admin') setNewDeptScope('Production');
                    else setNewDeptScope('');
                  }}
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 text-xs bg-white"
                >
                  {availableRoles.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Phạm Vi Bộ Phận</label>
                <select
                  value={newDeptScope}
                  onChange={e => setNewDeptScope(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 text-xs bg-white"
                >
                  <option value="">Toàn công ty</option>
                  <option value="WH">Kho (WH)</option>
                  <option value="QC">Quản lý chất lượng (QC)</option>
                  <option value="Production">Sản xuất (Production)</option>
                </select>
              </div>

              <div className="p-3 bg-orange-50 rounded-xl border border-orange-200 text-orange-800 text-[11px] leading-relaxed">
                ℹ️ <b>Mật khẩu mặc định:</b> Tài khoản mới sẽ được tự động khởi tạo với mật khẩu là <b>123</b>. Người dùng có thể tự thay đổi mật khẩu sau khi đăng nhập.
              </div>

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-bold rounded-xl shadow-sm transition"
                >
                  Tạo Tài Khoản
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {resetModalUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="p-2 bg-amber-100 text-amber-700 rounded-xl">
                  <KeyRound className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-extrabold text-slate-900 text-base">Đặt Lại Mật Khẩu</h3>
                  <p className="text-xs text-slate-500">Tài khoản: <b className="font-mono text-slate-800">{resetModalUser.username}</b> ({resetModalUser.displayName})</p>
                </div>
              </div>
              <button
                onClick={() => setResetModalUser(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Mật khẩu mới cho tài khoản:</label>
                <input
                  type="text"
                  value={newPasswordInput}
                  onChange={(e) => setNewPasswordInput(e.target.value)}
                  placeholder="Nhập mật khẩu mới (mặc định 123)"
                  className="w-full px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500 text-sm font-mono"
                />
              </div>

              <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-amber-900 text-xs space-y-1">
                <div className="font-bold flex items-center gap-1.5">
                  <Unlock className="w-4 h-4 text-amber-700" />
                  <span>Tự động mở khóa tài khoản</span>
                </div>
                <p className="text-[11px] text-amber-800">
                  Khi đặt lại mật khẩu, hệ thống sẽ tự động đặt số lần đăng nhập sai về 0 và mở khóa tài khoản nếu user đang bị khóa.
                </p>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setResetModalUser(null)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl transition"
                >
                  Hủy
                </button>
                <button
                  type="button"
                  onClick={handleConfirmResetPassword}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs rounded-xl shadow-sm transition flex items-center gap-1.5"
                >
                  <KeyRound className="w-4 h-4" />
                  <span>Xác Nhận Đổi Mật Khẩu</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
