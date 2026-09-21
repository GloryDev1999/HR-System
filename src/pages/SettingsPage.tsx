import React, { useState } from 'react';
import {
  Settings,
  Shield,
  SlidersHorizontal,
  Database,
  CheckCircle2,
  Save,
  RefreshCw,
  Lock,
  Layers,
  Award,
  Clock,
  KeyRound,
  Folder,
  AlertTriangle,
  FileJson,
  Upload,
  Download,
  Wifi,
  Radio,
  Server,
  Copy,
  ExternalLink,
  Zap,
  Activity,
  Users,
  Play
} from 'lucide-react';
import { lanSyncService, LanServerHealth, LanOnlineUser } from '../services/lan-sync-service';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';
import { RoleType, ISystemSettings } from '../types';
import { DEFAULT_SETTINGS } from '../lib/defaultSettings';
import { putSetting, clearTable } from '../lib/tables';

export const SettingsPage: React.FC = () => {
  const { session, currentRole, systemSettings, refreshPermissions, hasPermission, changePassword } = useAuth();
  const { success, warning, error, info } = useToast();
  const { confirm, openCustomModal, closeCustomModal } = useModal();

  const canManageRBAC = hasPermission('MANAGE_ROLES_PERMISSIONS');
  const canManageSystem = hasPermission('SYSTEM_SETTINGS');

  const [settings, setSettings] = useState<ISystemSettings>(systemSettings);

  // Đổi mật khẩu tài khoản hiện tại
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');

  const handleChangePassword = async () => {
    if (!pwCurrent || !pwNew) {
      warning('Thiếu thông tin', 'Vui lòng điền mật khẩu hiện tại và mật khẩu mới.');
      return;
    }
    if (pwNew !== pwConfirm) {
      warning('Mật khẩu không khớp', 'Xác nhận mật khẩu mới không trùng khớp.');
      return;
    }
    const res = await changePassword(pwCurrent, pwNew);
    if (res.ok) {
      success('Đã đổi mật khẩu', 'Mật khẩu tài khoản của bạn đã được cập nhật.');
      setPwCurrent('');
      setPwNew('');
      setPwConfirm('');
    } else {
      error('Đổi mật khẩu thất bại', res.error || 'Không rõ nguyên nhân');
    }
  };

  const [activeTab, setActiveTab] = useState<'rbac' | 'diligence' | 'formula' | 'system' | 'cloud'>('rbac');
  const [serverHealth, setServerHealth] = useState<LanServerHealth | null>(null);
  const [isPinging, setIsPinging] = useState(false);
  const [lanOnlineUsers, setLanOnlineUsers] = useState<LanOnlineUser[]>([]);

  React.useEffect(() => {
    lanSyncService.checkServerHealth().then(h => setServerHealth(h));
    const unsubPresence = lanSyncService.onPresence(users => setLanOnlineUsers(users));
    const unsubStatus = lanSyncService.onStatus((online, lat) => {
      setServerHealth(prev => prev ? { ...prev, status: online ? 'online' : 'offline', latencyMs: lat } : null);
    });
    return () => {
      unsubPresence();
      unsubStatus();
    };
  }, []);

  const handlePingServer = async () => {
    setIsPinging(true);
    try {
      const h = await lanSyncService.checkServerHealth();
      setServerHealth(h);
      if (h?.status === 'online') {
        success('Supabase trực tuyến', `Độ trễ phản hồi: ${h.latencyMs}ms.`);
      } else {
        warning('Supabase ngoại tuyến', 'Không thể kết nối Supabase. Kiểm tra mạng và VITE_SUPABASE_URL/ANON_KEY trong .env.');
      }
    } catch {
      error('Lỗi kết nối', 'Không thể ping máy chủ.');
    } finally {
      setIsPinging(false);
    }
  };

  const rolesList: RoleType[] = [
    'HR Manager',
    'HR Admin',
    'Warehouse Admin',
    'Production Admin',
    'QC Admin',
    'AD System'
  ];

  const permissionsList = [
    { id: 'VIEW_DASHBOARD', label: 'Xem Executive Dashboard & Báo Cáo' },
    { id: 'MANAGE_EMPLOYEES', label: 'Thêm, Sửa, Xóa Danh Mục Nhân Viên' },
    { id: 'IMPORT_LOGS', label: 'Import Dữ Liệu Chấm Công Máy (>20k dòng)' },
    { id: 'MANAGE_TIMESHEET', label: 'Sửa Mã Chấm Công 31 Ngày' },
    { id: 'MANAGE_OT', label: 'Phê Duyệt & Chốt Giờ Tăng Ca' },
    { id: 'MANAGE_LEAVE', label: 'Duyệt Bù Phép & Trừ Hạn Mức Phép Năm' },
    { id: 'MANAGE_ROSTER', label: 'Phân Ca & Điều Chỉnh Ca Vi Phạm <12h' },
    { id: 'SCAN_OCR', label: 'Quét OCR Phiếu Tăng Ca Tự Động' },
    { id: 'SYSTEM_SETTINGS', label: 'Cấu Hình Hệ Thống & Phân Quyền AD System' }
  ];

  const persistSettings = async (updated: ISystemSettings) => {
    setSettings(updated);
    try {
      await putSetting('systemSettings', updated);
      await refreshPermissions();
    } catch (e) {
      console.warn('Supabase settings persist failed', e);
    }
  };

  const handleTogglePermission = async (role: RoleType, permId: string) => {
    if (!canManageRBAC) {
      warning('Quyền hạn bị hạn chế', 'Tài khoản của bạn không có quyền MANAGE_ROLES_PERMISSIONS để chỉnh ma trận phân quyền.');
      return;
    }

    const currentPerms = settings.rolePermissions[role] || [];
    const isGranted = currentPerms.includes(permId) || currentPerms.includes('ALL_ACCESS');

    let updatedPerms: string[];
    if (isGranted) {
      updatedPerms = currentPerms.filter(p => p !== permId && p !== 'ALL_ACCESS');
    } else {
      updatedPerms = [...currentPerms, permId];
    }

    const updatedSettings: ISystemSettings = {
      ...settings,
      rolePermissions: {
        ...settings.rolePermissions,
        [role]: updatedPerms
      }
    };

    await persistSettings(updatedSettings);
    success('Đã cập nhật phân quyền (Supabase)', `Quyền ${permId} cho vai trò ${role} đã được cập nhật và đồng bộ realtime tới mọi máy.`);
  };

  const handleSaveDiligenceRules = async () => {
    await persistSettings(settings);
    success('Đã lưu cấu hình chuyên cần', 'Tỷ lệ giảm trừ tiền chuyên cần đã được áp dụng toàn hệ thống và đồng bộ Supabase.');
  };

  const handleSaveFormula = async () => {
    await persistSettings(settings);
    success('Đã lưu công thức tính toán', 'Công thức tiền năng suất (AW) và tiền chuyên cần (AX) đã được hệ thống hoá và áp dụng ngay cho Bảng chấm công & Xuất Excel.');
  };

  const handleResetDatabase = async () => {
    if (!canManageSystem) {
      warning('Không đủ quyền', 'Chỉ tài khoản có quyền SYSTEM_SETTINGS mới được làm sạch dữ liệu.');
      return;
    }
    const ok = await confirm({
      title: 'Làm sạch dữ liệu giao dịch',
      message: 'Hành động này sẽ xóa toàn bộ dữ liệu chấm công, tăng ca, nghỉ phép, sắp ca, OCR và nhật ký trên Supabase (giữ lại danh mục nhân viên, ca, quyền, chuyền và cấu hình). Bạn có chắc chắn không?',
      type: 'danger',
      confirmText: 'Làm sạch ngay',
      cancelText: 'Hủy bỏ'
    });

    if (ok) {
      await clearTable('dailyTimesheets');
      await clearTable('overtimeRecords');
      await clearTable('rawAttendanceLogs');
      await clearTable('leaveRequests');
      await clearTable('shiftRosters');
      await clearTable('ocrScans');
      await clearTable('userAuditLogs');
      await refreshPermissions();
      success('Làm sạch thành công', 'Dữ liệu giao dịch đã xóa. Nạp file chấm công mới từ thanh header để tiếp tục.');
    }
  };

  if (!canManageSystem && currentRole !== 'AD System') {
    return (
      <div className="p-8 max-w-xl mx-auto text-center mt-12 bg-white rounded-3xl border border-rose-100 shadow-sm">
        <div className="w-14 h-14 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-rose-200">
          <Lock className="w-6 h-6" />
        </div>
        <h2 className="text-base font-bold text-slate-900">Truy cập bị hạn chế</h2>
        <p className="text-xs text-slate-500 mt-2 leading-relaxed">
          Tài khoản vai trò <b>HR Manager (Kiều)</b> không được phép thao tác mục Cài đặt trong hệ thống.
          Vui lòng đăng nhập với tài khoản <b>Vinh (Admin System)</b> để truy cập tính năng này.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 w-full space-y-6 flex-1 flex flex-col">
      {/* Top Banner */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Settings className="w-5 h-5 text-orange-500" />
            <span>Cài Đặt Hệ Thống & Phân Quyền Chủ Động (System Configuration)</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Quản trị viên AD System có thể tùy biến ma trận phân quyền 6 vai trò, công thức giảm trừ chuyên cần và cài đặt tính toán tăng ca chuẩn.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('rbac')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'rbac'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Shield className="w-4 h-4 text-orange-400" />
          <span>Ma Trận Phân Quyền (RBAC Matrix)</span>
        </button>

        <button
          onClick={() => setActiveTab('diligence')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'diligence'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Award className="w-4 h-4 text-orange-400" />
          <span>Quy Tắc Chuyên Cần & Phép Năm</span>
        </button>

        <button
          onClick={() => setActiveTab('formula')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'formula'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <SlidersHorizontal className="w-4 h-4 text-emerald-400" />
          <span>Công Thức Năng Suất & Chuyên Cần</span>
        </button>

        <button
          onClick={() => setActiveTab('cloud')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'cloud'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Wifi className="w-4 h-4 text-emerald-400" />
          <span>Kết Nối Supabase Realtime</span>
          {lanOnlineUsers.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold">
              {lanOnlineUsers.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('system')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'system'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Database className="w-4 h-4 text-orange-400" />
          <span>Cơ Sở Dữ Liệu & Khôi Phục</span>
        </button>
      </div>

      {/* Tab Content 1: RBAC Matrix */}
      {activeTab === 'rbac' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Phân Quyền Chủ Động Theo 6 Vai Trò Doanh Nghiệp</h3>
              <p className="text-xs text-slate-500 mt-0.5">Bật / Tắt trực tiếp quyền truy cập theo từng module</p>
            </div>
            {!canManageRBAC && (
              <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-800 text-[11px] font-bold border border-amber-200 flex items-center gap-1">
                <Lock className="w-3 h-3 text-amber-600" />
                Chỉ xem (Cần quyền MANAGE_ROLES_PERMISSIONS)
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                <tr>
                  <th className="py-3 px-4 min-w-[240px]">Chức Năng & Quyền Hạn</th>
                  {rolesList.map(r => (
                    <th key={r} className="py-3 px-3 text-center min-w-[120px]">
                      <div className="font-bold">{r}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {permissionsList.map((perm) => (
                  <tr key={perm.id} className="hover:bg-slate-50/80 transition">
                    <td className="py-3 px-4 font-semibold text-slate-800">
                      {perm.label}
                    </td>
                    {rolesList.map(role => {
                      const perms = settings.rolePermissions[role] || [];
                      const isGranted = perms.includes('ALL_ACCESS') || perms.includes(perm.id);

                      return (
                        <td key={role} className="py-3 px-3 text-center">
                          <button
                            onClick={() => handleTogglePermission(role, perm.id)}
                            disabled={!canManageRBAC || (role === 'AD System' && perm.id === 'SYSTEM_SETTINGS')}
                            className={`w-6 h-6 rounded-lg font-bold inline-flex items-center justify-center transition ${
                              isGranted
                                ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-200'
                                : 'bg-slate-100 text-slate-300 hover:bg-slate-200'
                            }`}
                          >
                            {isGranted && <CheckCircle2 className="w-4 h-4" />}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab Content 2: Diligence & Leave rules */}
      {activeTab === 'diligence' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-6">
          <div>
            <h3 className="text-base font-bold text-slate-900">Cấu Hình Giảm Trừ Tiền Chuyên Cần & Hạn Mức Phép Năm</h3>
            <p className="text-xs text-slate-500 mt-1">
              Định nghĩa tỷ lệ giảm trừ tiền chuyên cần khi nhân viên nghỉ việc riêng không hưởng lương (UL). Có thể tùy biến riêng theo từng phòng ban.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-slate-100">
            {/* Global Rule */}
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-4">
              <h4 className="font-bold text-xs text-slate-900 uppercase tracking-wider flex items-center gap-2">
                <SlidersHorizontal className="w-4 h-4 text-orange-500" />
                <span>Quy Tắc Chuyên Cần Mặc Định (Toàn Hệ Thống)</span>
              </h4>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Nghỉ 2 ngày không lương (UL &ge; 2 ngày):</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={settings.diligenceDeductionRules[0]?.twoDaysULPenaltyPct ?? 50}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value) || 0;
                      const rules = [...settings.diligenceDeductionRules];
                      rules[0].twoDaysULPenaltyPct = val;
                      setSettings({ ...settings, diligenceDeductionRules: rules });
                    }}
                    className="w-24 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-800"
                  />
                  <span className="text-xs text-slate-500">% giảm trừ tiền chuyên cần (Mặc định 50%)</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Nghỉ từ 3 ngày không lương (UL &ge; 3 ngày):</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={settings.diligenceDeductionRules[0]?.threeDaysULPenaltyPct ?? 100}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value) || 0;
                      const rules = [...settings.diligenceDeductionRules];
                      rules[0].threeDaysULPenaltyPct = val;
                      setSettings({ ...settings, diligenceDeductionRules: rules });
                    }}
                    className="w-24 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-800"
                  />
                  <span className="text-xs text-slate-500">% giảm trừ tiền chuyên cần (Mặc định 100%)</span>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-200">
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={settings.diligenceBonusConfig?.countOffAsUL ?? true}
                    onChange={(e) => setSettings({
                      ...settings,
                      diligenceBonusConfig: {
                        ...(settings.diligenceBonusConfig || { baseAmount: 500000, countRange: 'J:AM', countOffAsUL: true }),
                        countOffAsUL: e.target.checked
                      }
                    })}
                    className="rounded text-orange-500"
                  />
                  <span>Cộng dồn nghỉ không phép (Off) và không lương (UL) khi xét chuyên cần</span>
                </label>
              </div>

              <div className="pt-2 border-t border-slate-200">
                <label className="block text-xs font-semibold text-slate-700 mb-1">Mức trích đoàn phí hàng tháng:</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={settings.tradeUnionFee ?? 40000}
                    onChange={(e) => setSettings({ ...settings, tradeUnionFee: parseFloat(e.target.value) || 0 })}
                    className="w-28 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-800"
                  />
                  <span className="text-xs text-slate-500">VNĐ / tháng (Mặc định 40.000 VNĐ, tuỳ chỉnh tự do)</span>
                </div>
              </div>
            </div>

            {/* Overtime & Quota Defaults */}
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-4">
              <h4 className="font-bold text-xs text-slate-900 uppercase tracking-wider flex items-center gap-2">
                <Clock className="w-4 h-4 text-orange-500" />
                <span>Quy Tắc Tính Tăng Ca & Phép Năm Ban Đầu</span>
              </h4>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Phương thức tính giờ tăng ca:</label>
                <div className="p-2 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg text-xs font-bold">
                  ✓ Tính đúng theo giờ chuẩn thực tế (không làm tròn)
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Hạn mức phép năm ban đầu mặc định:</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={settings.defaultAnnualLeaveQuota}
                    onChange={(e) => setSettings({ ...settings, defaultAnnualLeaveQuota: parseFloat(e.target.value) || 12 })}
                    className="w-24 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-800"
                  />
                  <span className="text-xs text-slate-500">ngày/năm (Có thể sửa tự do theo từng cá nhân)</span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-4 border-t border-slate-100">
            <button
              onClick={handleSaveDiligenceRules}
              className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-orange-500 to-rose-500 hover:from-orange-600 hover:to-rose-600 text-white font-bold text-xs rounded-xl shadow-md shadow-orange-200 transition"
            >
              <Save className="w-4 h-4" />
              <span>Lưu Cấu Hình Chuyên Cần</span>
            </button>
          </div>
        </div>
      )}

      {/* Tab Content 2b: Formula — hệ thống hoá AW & AX, không khóa cứng */}
      {activeTab === 'formula' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-6">
          <div>
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <SlidersHorizontal className="w-5 h-5 text-emerald-500" />
              <span>Hệ Thống Hoá Công Thức — Không Khóa Cứng (Custom Formula)</span>
            </h3>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">
              Hai công thức trước đây bị khóa cứng nay được đưa vào <b>Cài đặt</b> để chỉnh tự do: <code className="px-1 py-0.5 bg-slate-100 rounded text-[11px]">AW=(AO+AP)*BF/AN</code> (năng suất) và <code className="px-1 py-0.5 bg-slate-100 rounded text-[11px]">AX=base*(1-IF(UL…))</code> (chuyên cần). Thay đổi áp dụng ngay cho <b>Bảng chấm công</b> và <b>Xuất Excel</b>.
            </p>
            <div className="mt-2 p-2.5 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-900">
              Excel gốc: <b>AW13 =(AO13+AP13)*BF13/AN13</b> (BF ẩn = tiền năng suất base từ anh Khoa, AN=công chuẩn), <b>AX13 =500000*(1-IF(COUNTIF(J13:AM13,"UL")&gt;=2, IF(...&gt;=3,1,0.5),0))</b> (J:AM khớp file gốc, tính Off như UL)
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pt-4 border-t border-slate-100">
            {/* Năng suất AW */}
            <div className="p-4 bg-emerald-50/40 rounded-xl border border-emerald-200 space-y-4">
              <h4 className="font-bold text-xs text-emerald-900 uppercase tracking-wider flex items-center gap-2">
                <Layers className="w-4 h-4 text-emerald-600" />
                <span>Tiền Năng Suất (AW) — (AO+AP)*BF/AN</span>
              </h4>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Công thức (hiển thị, hệ thống tự áp dụng JS & Excel)</label>
                <input
                  type="text"
                  value={settings.productivityBonusConfig?.formula || '(AO+AP)*BF/AN'}
                  onChange={(e) => setSettings({ ...settings, productivityBonusConfig: { ...settings.productivityBonusConfig!, formula: e.target.value } })}
                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-mono"
                  placeholder="(TotalWD+TotalAL)*BaseRate/StandardWD"
                />
                <p className="text-[11px] text-slate-500 mt-1">JS: <code>(actualWD+annualLeaveAL)*baseRate/standardWD</code> — Excel: <code>=(AO+AP)*BF/AN</code></p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">BaseRate mặc định BF cho NV mới (VNĐ)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={settings.productivityBonusConfig?.defaultBaseRate ?? 1000000}
                    onChange={(e) => setSettings({ ...settings, productivityBonusConfig: { ...settings.productivityBonusConfig!, defaultBaseRate: parseFloat(e.target.value) || 0 } })}
                    className="w-36 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold"
                  />
                  <span className="text-xs text-slate-500">áp dụng khi NV chưa có <code>Chi phí năng suất</code> riêng (trong Danh mục NV)</span>
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={!!settings.productivityBonusConfig?.useDepartmentOverride} onChange={(e) => setSettings({ ...settings, productivityBonusConfig: { ...settings.productivityBonusConfig!, useDepartmentOverride: e.target.checked } })} className="rounded" />
                <span>Cho phép override BaseRate theo phòng ban (mở bảng nhập bên dưới)</span>
              </label>
              {settings.productivityBonusConfig?.useDepartmentOverride && (
                <div className="space-y-2 max-h-[160px] overflow-y-auto border border-emerald-100 rounded-xl p-2 bg-white">
                  {Array.from(new Set(['Production','WH','QC','Logistics','Finance','EHS'].concat(Object.keys(settings.productivityBonusConfig.departmentBaseRates || {})))).map(dept => (
                    <div key={dept} className="flex items-center gap-2 text-xs">
                      <span className="w-28 font-semibold text-slate-700 truncate">{dept}</span>
                      <input
                        type="number"
                        value={settings.productivityBonusConfig.departmentBaseRates?.[dept] ?? settings.productivityBonusConfig.defaultBaseRate}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value) || 0;
                          setSettings({ ...settings, productivityBonusConfig: { ...settings.productivityBonusConfig!, departmentBaseRates: { ...(settings.productivityBonusConfig.departmentBaseRates || {}), [dept]: v } } });
                        }}
                        className="flex-1 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                      />
                    </div>
                  ))}
                </div>
              )}
              <div className="p-2 bg-white rounded-lg border border-emerald-100 text-[11px] text-slate-600">
                <b>BF</b> = tiền năng suất base (cột ẩn BF trong Excel, NV có thể chỉnh ở Danh mục NV → Tiền năng suất). Nhân viên không có AW sẽ để BF=0.
              </div>
            </div>

            {/* Chuyên cần AX */}
            <div className="p-4 bg-orange-50/40 rounded-xl border border-orange-200 space-y-4">
              <h4 className="font-bold text-xs text-orange-900 uppercase tracking-wider flex items-center gap-2">
                <Award className="w-4 h-4 text-orange-600" />
                <span>Tiền Chuyên Cần (AX) — base*(1-IF(UL...))</span>
              </h4>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">BaseAmount mặc định (VNĐ)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={settings.diligenceBonusConfig?.baseAmount ?? 500000}
                    onChange={(e) => setSettings({ ...settings, diligenceBonusConfig: { ...settings.diligenceBonusConfig!, baseAmount: parseFloat(e.target.value) || 0 } })}
                    className="w-36 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold"
                  />
                  <span className="text-xs text-slate-500">Excel: <code>=base*(1-IF(COUNTIF(...UL...)&gt;=2,...,0))</code></span>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">Per-NV có thể override qua <b>Danh mục NV → Tiền chuyên cần</b> riêng (ưu tiên hơn base này).</p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Phạm vi COUNTIF UL trong Excel (khớp file gốc)</label>
                <select
                  value={settings.diligenceBonusConfig?.countRange || 'J:AM'}
                  onChange={(e) => setSettings({ ...settings, diligenceBonusConfig: { ...settings.diligenceBonusConfig!, countRange: e.target.value as any } })}
                  className="w-36 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold"
                >
                  <option value="J:AM">J:AM (khớp file gốc 08/2026)</option>
                  <option value="I:AM">I:AM (toàn 31 cột)</option>
                </select>
                <p className="text-[11px] text-slate-500 mt-1">File gốc dùng <code>J13:AM13</code> (bỏ cột 21), hệ thống cho phép đổi.</p>
              </div>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                <input type="checkbox" checked={!!settings.diligenceBonusConfig?.countOffAsUL} onChange={(e) => setSettings({ ...settings, diligenceBonusConfig: { ...settings.diligenceBonusConfig!, countOffAsUL: e.target.checked } })} className="rounded" />
                <span>Tính <code>Off</code> như <code>UL</code> khi đếm (buildCountBag)</span>
              </label>
              <div className="p-2 bg-white rounded-lg border border-orange-100 text-[11px] text-slate-600">
                Giảm trừ lấy từ <b>Quy tắc chuyên cần</b> tab trước (50% nếu ≥2 UL, 100% nếu ≥3 UL) — áp dụng chung cho công thức này.
              </div>
            </div>

            {/* Năng suất Nhóm 2 */}
            <div className="p-4 bg-purple-50/40 rounded-xl border border-purple-200 space-y-4 lg:col-span-2">
              <h4 className="font-bold text-xs text-purple-900 uppercase tracking-wider flex items-center gap-2">
                <Layers className="w-4 h-4 text-purple-600" />
                <span>Tiền Năng Suất Nhóm 2 — (ActualWD + AL) × 1.000.000 / StandardWD</span>
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Đơn giá năng suất chuẩn Nhóm 2 (VNĐ):</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      value={settings.productivityBonusConfig?.defaultBaseRate ?? 1000000}
                      onChange={(e) => setSettings({
                        ...settings,
                        productivityBonusConfig: {
                          ...settings.productivityBonusConfig!,
                          defaultBaseRate: parseFloat(e.target.value) || 0
                        }
                      })}
                      className="w-36 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold"
                    />
                    <span className="text-xs text-slate-500">Mặc định: 1.000.000 VNĐ</span>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Quy tắc giảm trừ khi nghỉ không lương / không phép (UL / Off):</label>
                  <select
                    value={settings.productivityBonusConfig?.deductULGroup2Rule || 'same_as_diligence'}
                    onChange={(e) => setSettings({
                      ...settings,
                      productivityBonusConfig: {
                        ...settings.productivityBonusConfig!,
                        deductULGroup2Rule: e.target.value as any
                      }
                    })}
                    className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium"
                  >
                    <option value="same_as_diligence">Nghỉ 2 ngày giảm 50%, từ 3 ngày = 0đ (theo quy tắc chuyên cần)</option>
                    <option value="zero">Có nghỉ không lương / không phép là không được nhận (= 0đ)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-purple-100">
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={!settings.productivityBonusConfig?.probationGetsBonusGroup2}
                    onChange={(e) => setSettings({
                      ...settings,
                      productivityBonusConfig: {
                        ...settings.productivityBonusConfig!,
                        probationGetsBonusGroup2: !e.target.checked
                      }
                    })}
                    className="rounded text-purple-600"
                  />
                  <span>Nhân viên đang thử việc không được nhận thưởng năng suất Nhóm 2 (= 0đ)</span>
                </label>

                <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
                  <input
                    type="checkbox"
                    checked={!!settings.productivityBonusConfig?.applyLineRatesToGroup2}
                    onChange={(e) => setSettings({
                      ...settings,
                      productivityBonusConfig: {
                        ...settings.productivityBonusConfig!,
                        applyLineRatesToGroup2: e.target.checked
                      }
                    })}
                    className="rounded text-purple-600"
                  />
                  <span>Nhân thêm tỷ lệ % Năng Suất & % Chất Lượng của Chuyền (nếu gán Line)</span>
                </label>
              </div>

              <div className="p-2 bg-white rounded-lg border border-purple-100 text-[11px] text-slate-600">
                Công thức Nhóm 2: <code>(Công thực tế + Phép năm) × Đơn giá (1.000.000đ) / Công chuẩn</code>. Áp dụng cho các nhân viên thuộc Nhóm Năng Suất 2 trong Danh mục nhân viên.
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-4 border-t border-slate-100">
            <button onClick={handleSaveFormula} className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-bold text-xs rounded-xl shadow-md shadow-emerald-200 transition">
              <Save className="w-4 h-4" />
              <span>Lưu Công Thức</span>
            </button>
          </div>
        </div>
      )}

      {/* Tab Content 3: System & DB Reset */}
      {activeTab === 'system' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-6">
          <div>
            <h3 className="text-base font-bold text-slate-900">Quản Trị Cơ Sở Dữ Liệu Trình Duyệt (Dexie.js IndexedDB)</h3>
            <p className="text-xs text-slate-500 mt-1">
              Toàn bộ dữ liệu được lưu trữ cục bộ tại máy người dùng. Bạn có thể khôi phục lại dữ liệu chuẩn từ file thực tế bất cứ lúc nào.
            </p>
          </div>

          <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-3">
            <h4 className="font-bold text-xs text-slate-900 uppercase tracking-wider">Đổi mật khẩu tài khoản ({session?.username})</h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input
                type="password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                placeholder="Mật khẩu hiện tại"
                aria-label="Mật khẩu hiện tại"
                className="px-3 py-2 text-xs border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-400/50"
              />
              <input
                type="password"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
                placeholder="Mật khẩu mới (>= 6 ký tự)"
                aria-label="Mật khẩu mới"
                className="px-3 py-2 text-xs border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-400/50"
              />
              <input
                type="password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                placeholder="Xác nhận mật khẩu mới"
                aria-label="Xác nhận mật khẩu mới"
                className="px-3 py-2 text-xs border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-400/50"
              />
            </div>
            <button
              onClick={handleChangePassword}
              className="flex items-center gap-2 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl transition shadow-sm"
            >
              <KeyRound className="w-4 h-4 text-orange-400" />
              <span>Cập Nhật Mật Khẩu</span>
            </button>
          </div>

          <div className="p-4 bg-rose-50/50 rounded-xl border border-rose-200 space-y-3">
            <h4 className="font-bold text-xs text-rose-900 uppercase tracking-wider">Khôi phục cơ sở dữ liệu về mặc định</h4>
            <p className="text-xs text-slate-600">
              Nạp lại toàn bộ 102 nhân viên, 3,162 ô công và 196 bản ghi tăng ca gốc từ tài liệu chốt công.
            </p>
            <button
              onClick={handleResetDatabase}
              className="flex items-center gap-2 px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-xl transition shadow-md shadow-rose-200"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Khôi Phục Dữ Liệu Gốc</span>
            </button>
          </div>
        </div>
      )}

      {activeTab === 'cloud' && (
        <div className="space-y-6 animate-in fade-in duration-200">
          {/* Header Card */}
          <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-emerald-950 text-white p-6 rounded-2xl shadow-sm border border-slate-700/50 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-emerald-500/20 rounded-xl text-emerald-400 border border-emerald-500/30">
                  <Wifi className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold flex items-center gap-2">
                    Supabase Realtime (thay máy chủ LAN)
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold border ${
                      serverHealth?.status === 'online'
                        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                        : 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                    }`}>
                      <span className={`w-2 h-2 rounded-full ${serverHealth?.status === 'online' ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
                      {serverHealth?.status === 'online' ? 'ĐÃ KẾT NỐI' : 'CHƯA KẾT NỐI'}
                    </span>
                  </h3>
                  <p className="text-xs text-slate-300 mt-0.5">
                    Mọi máy đọc/ghi chung một Postgres. Presence, broadcast và thay đổi dữ liệu đồng bộ tức thời — không còn server LAN, file JSON hay quét thư mục.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handlePingServer}
                disabled={isPinging}
                className="flex items-center gap-1.5 px-3.5 py-2 bg-white/10 hover:bg-white/20 border border-white/20 text-white rounded-xl text-xs font-bold transition shadow-xs"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isPinging ? 'animate-spin' : ''}`} />
                <span>{isPinging ? 'Đang kiểm tra...' : 'Kiểm tra Ping'}</span>
              </button>
            </div>
          </div>

          {/* KPI Metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-2 gap-4">
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Độ Trễ Supabase (Ping)</div>
              <div className="text-2xl font-black text-slate-900 mt-1 flex items-baseline gap-1">
                {serverHealth?.status === 'online' ? serverHealth.latencyMs : '--'}
                <span className="text-xs font-semibold text-slate-500">ms</span>
              </div>
              <div className="text-[10px] text-emerald-600 font-semibold mt-1 flex items-center gap-1">
                <Activity className="w-3 h-3" /> Supabase REST + Realtime
              </div>
            </div>

            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
              <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Đang Trực Tuyến</div>
              <div className="text-2xl font-black text-emerald-600 mt-1">
                {lanOnlineUsers.length} <span className="text-xs font-semibold text-slate-500">user</span>
              </div>
              <div className="text-[10px] text-slate-500 mt-1">Cập nhật qua Supabase Presence</div>
            </div>
          </div>

          {/* Realtime Online Users Table */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Users className="w-4 h-4 text-emerald-600" />
                  <span>Người Dùng Đang Trực Tuyến ({lanOnlineUsers.length})</span>
                </h4>
                <p className="text-xs text-slate-500 mt-0.5">Hiển thị tức thời khi có người mở tab hoặc đổi phân hệ</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-700 font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">Nhân Sự & Tài Khoản</th>
                    <th className="py-3 px-3">Vai Trò</th>
                    <th className="py-3 px-3">Phân Hệ Đang Mở</th>
                    <th className="py-3 px-3 text-right">Trạng Thái</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lanOnlineUsers.length > 0 ? (
                    lanOnlineUsers.map((u) => (
                      <tr key={u.username} className="hover:bg-slate-50/80 transition">
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2.5">
                            <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-indigo-500 to-blue-600 text-white font-bold flex items-center justify-center text-xs shadow-xs">
                              {u.displayName.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div className="font-bold text-slate-900">{u.displayName}</div>
                              <div className="text-[10px] text-slate-400 font-mono">@{u.username}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <span className="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 font-semibold text-[10px] border border-blue-200">
                            {u.role}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-slate-700 font-medium">{u.currentTab || 'Bảng điều khiển'}</td>
                        <td className="py-3 px-3 text-right">
                          <span className="inline-flex items-center gap-1 text-emerald-600 font-bold text-[11px]">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                            Trực tuyến
                          </span>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-slate-400 italic">
                        Chưa có người dùng nào khác trực tuyến.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};