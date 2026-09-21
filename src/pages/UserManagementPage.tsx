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
import { useLiveTable } from '../lib/tables';
import type { RoleType, AuditActionType, IUserAuditLog } from '../types';

/** Danh mục 6 tài khoản vận hành (provisioned trong Supabase Auth, role trong app_metadata).
 *  Frontend anon-key không liệt kê được auth.users nên dùng danh mục tĩnh này để hiển thị/lọc.
 *  Mọi thao tác sửa/khóa/reset thực hiện trong Supabase Dashboard → Authentication. */
interface DirectoryAccount {
  email: string;
  username: string;
  displayName: string;
  role: RoleType;
  departmentScope: string | null;
}
const KNOWN_ACCOUNTS: DirectoryAccount[] = [
  { email: 'kieu@leggett.com', username: 'kieu', displayName: 'Kieu(Mia)', role: 'AD System', departmentScope: null },
  { email: 'hoa@leggett.com', username: 'hoa', displayName: 'Hoa(Molly)', role: 'HR Manager', departmentScope: null },
  { email: 'vinh@leggett.com', username: 'vinh', displayName: 'Vinh(Glory)', role: 'Warehouse Admin', departmentScope: 'WH' },
  { email: 'nguyetanh@leggett.com', username: 'nguyetanh', displayName: 'Nguyet Anh', role: 'QC Admin', departmentScope: 'QC' },
  { email: 'han@leggett.com', username: 'han', displayName: 'Han', role: 'Production Admin', departmentScope: 'Production' },
  { email: 'glory@leggett.com', username: 'glory', displayName: 'Glory(Software)', role: 'AD System', departmentScope: null },
];
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';

export const UserManagementPage: React.FC = () => {
  const { session, createAccount, hasPermission } = useAuth();
  const { success, error, warning } = useToast();
  const { confirm } = useModal();

  const [activeTab, setActiveTab] = useState<'users' | 'audit'>('users');

  // Queries: danh mục tĩnh (Auth không cho anon list users) + audit realtime
  const accounts = KNOWN_ACCOUNTS;
  const auditLogs = useLiveTable<IUserAuditLog>('userAuditLogs', { orderBy: 'createdAt', ascending: false, limit: 200 });

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

  // Roles available
  const availableRoles: RoleType[] = [
    'AD System',
    'HR Manager',
    'HR Admin',
    'Warehouse Admin',
    'Production Admin',
    'QC Admin'
  ];

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUsername.trim()) {
      warning('Thiếu thông tin', 'Vui lòng nhập tên đăng nhập.');
      return;
    }

    const rawName = newUsername.trim().toLowerCase();
    const mail = rawName.includes('@') ? rawName : `${rawName}@leggett.com`;
    const dname = newDisplayName.trim() || rawName;

    const res = await createAccount(mail, dname, newRole, '123456', newDeptScope || null);
    if (res.ok) {
      success('Tạo tài khoản thành công', `Tài khoản "${mail}" đã được tạo (mật khẩu "123456"). NHỚ gán vai trò "${newRole}" trong Dashboard → Authentication → user → App Metadata rồi mới phân quyền có hiệu lực.`);
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
            Tài khoản lưu trong Supabase Auth (vai trò trong App Metadata). Thêm user mới ở đây, còn sửa vai trò / khóa / reset mật khẩu người khác thực hiện trong Supabase Dashboard → Authentication. Mật khẩu khởi tạo mặc định là <b>123456</b>.
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
                {accounts.map(acc => (
                  <tr key={acc.email} className="hover:bg-slate-50/80 transition">
                    {/* Email */}
                    <td className="py-3 px-4 font-mono font-bold text-slate-900">
                      {acc.email}
                      {acc.username === session?.username && (
                        <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-700 border border-orange-200">
                          Đang đăng nhập
                        </span>
                      )}
                    </td>

                    {/* Display Name */}
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-800">{acc.displayName}</div>
                    </td>

                    {/* Role */}
                    <td className="py-3 px-4">
                      <span className="px-2.5 py-1 rounded-full text-[11px] font-extrabold bg-slate-100 text-slate-800 border border-slate-200">
                        {acc.role}
                      </span>
                    </td>

                    {/* Department Scope */}
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1.5 text-slate-600 font-medium">
                        <Building2 className="w-3.5 h-3.5 text-slate-400" />
                        <span>{acc.departmentScope ? `${acc.departmentScope}` : 'Toàn công ty'}</span>
                      </div>
                    </td>

                    {/* Active State */}
                    <td className="py-3 px-4">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                        <span>Hoạt động</span>
                      </span>
                    </td>

                    {/* Actions */}
                    <td className="py-3 px-4 text-center">
                      <span className="text-[11px] text-slate-400 italic">Quản lý trong Supabase Dashboard</span>
                    </td>
                  </tr>
                ))}              </tbody>
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

    </div>
  );
};
