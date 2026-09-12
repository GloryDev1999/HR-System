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
  Network,
  Server,
  Laptop,
  Wifi,
  Radio,
  Link2,
  Copy,
  Check,
  X,
  Folder
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';
import { RoleType, ISystemSettings } from '../types';
import { DEFAULT_SETTINGS, db } from '../db';
import { seedDatabaseIfEmpty } from '../services/db-seeder';
import { clusterService } from '../services/webrtc-cluster-service';
import { folderSignaling } from '../services/folder-signaling-service';

export const SettingsPage: React.FC = () => {
  const { session, currentRole, systemSettings, refreshPermissions, hasPermission, changePassword } = useAuth();
  const { success, warning, error } = useToast();
  const { confirm } = useModal();

  const canManageRBAC = hasPermission('MANAGE_ROLES_PERMISSIONS');
  const canManageSystem = hasPermission('SYSTEM_SETTINGS');

  const [settings, setSettings] = useState<ISystemSettings>(systemSettings);

  // WebRTC P2P Cluster state
  const [clusterConfig, setClusterConfig] = useState(() => clusterService.getConfig());
  const [clusterStatus, setClusterStatus] = useState(() => clusterService.getStatus());

  // WebRTC P2P Offline Pairing Token Modal state
  const [isPairModalOpen, setIsPairModalOpen] = useState(false);
  const [pairClientId, setPairClientId] = useState('CLIENT_01');
  const [generatedPairToken, setGeneratedPairToken] = useState('');
  const [inputPairToken, setInputPairToken] = useState('');
  const [isPairWorking, setIsPairWorking] = useState(false);
  const [hasCopiedPairToken, setHasCopiedPairToken] = useState(false);

  React.useEffect(() => {
    return clusterService.onStatusChange((status) => {
      setClusterStatus(status);
      setClusterConfig(clusterService.getConfig());
    });
  }, []);

  // WebRTC Folder Signaling state (HR_Signaling_Data trên OneDrive)
  const [hasFolderHandle, setHasFolderHandle] = useState(() => folderSignaling.hasDirectoryHandle());
  const [isFolderGranted, setIsFolderGranted] = useState(() => folderSignaling.isPermissionGranted());
  const [folderName, setFolderName] = useState(() => folderSignaling.getFolderName());

  React.useEffect(() => {
    return folderSignaling.onStatusChange((has, name, isGranted) => {
      setHasFolderHandle(has);
      setFolderName(name);
      setIsFolderGranted(isGranted);
    });
  }, []);

  const handlePickSignalingFolder = async () => {
    try {
      let ok = false;
      if (hasFolderHandle && !isFolderGranted) {
        ok = await folderSignaling.requestPermission();
      } else {
        ok = await folderSignaling.pickDirectory();
      }
      if (ok) {
        success('Đã liên kết thư mục', `Hệ thống đã kết nối thành công với thư mục "${folderSignaling.getFolderName()}". File JSON tín hiệu WebRTC sẽ tự động đồng bộ tại đây.`);
        if (clusterConfig.nodeRole === 'HOST') {
          clusterService.quickStartAsHost().catch(console.error);
        } else {
          clusterService.quickConnectAsClient(session?.username || 'vinh', session?.displayName).catch(console.error);
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        error('Lỗi chọn thư mục', err.message);
      }
    }
  };

  // Sync when AuthContext updates (Dexie live)
  React.useEffect(() => {
    setSettings(systemSettings);
  }, [systemSettings]);

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

  const [activeTab, setActiveTab] = useState<'rbac' | 'diligence' | 'formula' | 'cluster' | 'system'>('rbac');

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
    localStorage.setItem('smarthr_settings', JSON.stringify(updated));
    try {
      await db.settings.put({ key: 'systemSettings', value: updated });
      await refreshPermissions();
    } catch (e) {
      console.warn('Dexie settings persist failed', e);
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
    success('Đã cập nhật phân quyền (Dexie + localStorage)', `Quyền ${permId} cho vai trò ${role} đã được cập nhật và đồng bộ vào IndexedDB.`);
  };

  const handleSaveDiligenceRules = async () => {
    await persistSettings(settings);
    success('Đã lưu cấu hình chuyên cần', 'Tỷ lệ giảm trừ tiền chuyên cần đã được áp dụng toàn hệ thống và đồng bộ Dexie.');
  };

  const handleSaveFormula = async () => {
    await persistSettings(settings);
    success('Đã lưu công thức tính toán', 'Công thức tiền năng suất (AW) và tiền chuyên cần (AX) đã được hệ thống hoá và áp dụng ngay cho Bảng chấm công & Xuất Excel.');
  };

  const handleResetDatabase = async () => {
    if (!canManageSystem) {
      warning('Không đủ quyền', 'Chỉ tài khoản có quyền SYSTEM_SETTINGS mới được khôi phục dữ liệu.');
      return;
    }
    const ok = await confirm({
      title: 'Khôi phục dữ liệu mặc định',
      message: 'Hành động này sẽ xóa toàn bộ dữ liệu hiện tại trong IndexedDB và nạp lại dữ liệu chuẩn từ file KIỂM TRA CHÔT CÔNG THÁNG 08.2026.xlsx. Bạn có chắc chắn không?',
      type: 'danger',
      confirmText: 'Khôi phục ngay',
      cancelText: 'Hủy bỏ'
    });

    if (ok) {
      await db.delete();
      await db.open();
      await seedDatabaseIfEmpty();
      await refreshPermissions();
      success('Khôi phục dữ liệu thành công', 'Toàn bộ danh mục nhân viên và bảng chốt công đã được đồng bộ lại.');
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
          onClick={() => setActiveTab('cluster')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'cluster'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Network className="w-4 h-4 text-cyan-400" />
          <span>Mạng P2P Cụm (WebRTC RTCDataChannel)</span>
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

      {/* Tab Content 5: WebRTC P2P Cluster (Star-Topology 1 Host - 5 Clients) */}
      {activeTab === 'cluster' && (
        <div className="space-y-6">
          {/* Architecture Banner */}
          <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white p-6 rounded-2xl border border-indigo-900/50 shadow-xl relative overflow-hidden">
            <div className="relative z-10 space-y-3">
              <div className="flex items-center gap-3">
                <span className="p-2.5 bg-indigo-500/20 rounded-xl border border-indigo-500/40 text-indigo-400">
                  <Network className="w-6 h-6" />
                </span>
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <span>Kiến Trúc Cụm Mạng Hình Sao P2P (Star-Topology via RTCDataChannel)</span>
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black bg-indigo-500/30 text-indigo-300 border border-indigo-400/40">
                      1 HOST (Master DB) + 5 CLIENTS
                    </span>
                  </h3>
                  <p className="text-xs text-indigo-200/80 mt-0.5">
                    100% In-Browser trên Microsoft Edge — Không file .exe, không mở Port OS, an toàn tuyệt đối với CrowdStrike Falcon EDR
                  </p>
                </div>
              </div>

              <div className="p-3 bg-white/5 rounded-xl border border-white/10 text-xs text-indigo-100 flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
                  <span className="font-semibold">Trạng thái Node hiện tại:</span>
                  <span className="font-black text-amber-300">
                    {clusterConfig.nodeRole === 'HOST' ? 'MÁY CHỦ HOST (MASTER DB)' : 'MÁY TRẠM CLIENT'}
                  </span>
                  <span className="text-slate-400">({clusterStatus})</span>
                </div>
                <div className="text-[11px] text-indigo-300">
                  Signaling Folder: <code className="bg-black/30 px-2 py-0.5 rounded text-amber-300 font-mono">{clusterConfig.syncFolderName}</code> (OneDrive)
                </div>
              </div>
            </div>
          </div>

          {/* Node Configuration Form */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Server className="w-4 h-4 text-orange-500" />
                <span>Cấu Hình Node Trên Máy Này (Dynamic Node Configuration)</span>
              </h4>
              <span className="text-xs text-slate-400">Lưu trữ cục bộ IndexedDB & Tự động nhận diện</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">Vai trò của máy này:</label>
                <select
                  value={clusterConfig.nodeRole}
                  onChange={(e) => setClusterConfig({ ...clusterConfig, nodeRole: e.target.value as any })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-bold text-slate-900 focus:ring-2 focus:ring-orange-400"
                >
                  <option value="HOST">HOST — Máy Chủ (Kieu nắm Master DB)</option>
                  <option value="CLIENT">CLIENT — Máy Trạm (Vinh, Han, Nguyet Anh, Hoa, Glory)</option>
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Mã định danh Node (Node ID):</label>
                <input
                  type="text"
                  value={clusterConfig.nodeId}
                  onChange={(e) => setClusterConfig({ ...clusterConfig, nodeId: e.target.value })}
                  placeholder="HOST_KIEU_01 hoặc CLIENT_VINH_01"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-mono text-slate-800"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Tên máy hiển thị:</label>
                <input
                  type="text"
                  value={clusterConfig.displayName}
                  onChange={(e) => setClusterConfig({ ...clusterConfig, displayName: e.target.value })}
                  placeholder="Kieu(Mia) - Máy Chủ Quản Lý"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 font-semibold"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">
                  Thư mục Tín Hiệu WebRTC (HR_Signaling_Data trên OneDrive):
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={clusterConfig.syncFolderName}
                    onChange={(e) => setClusterConfig({ ...clusterConfig, syncFolderName: e.target.value })}
                    placeholder="HR_Signaling_Data"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-mono text-slate-800 grow"
                  />
                  <button
                    onClick={handlePickSignalingFolder}
                    type="button"
                    className={`flex items-center gap-1.5 px-4 py-2 rounded-xl font-bold text-xs shrink-0 transition shadow-xs border ${
                      hasFolderHandle && isFolderGranted
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                        : hasFolderHandle && !isFolderGranted
                        ? 'bg-amber-100 text-amber-900 border-amber-300 hover:bg-amber-200'
                        : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100'
                    }`}
                  >
                    <Folder className="w-4 h-4 text-amber-500" />
                    <span>
                      {hasFolderHandle && isFolderGranted
                        ? `Đã chọn: ${folderName || 'HR_Signaling_Data'}`
                        : hasFolderHandle && !isFolderGranted
                        ? `⚠️ Cấp Quyền: ${folderName || 'HR_Signaling_Data'}`
                        : '📁 Chọn Thư Mục HR_Signaling_Data'}
                    </span>
                  </button>
                </div>
                <div className="text-[11px] text-slate-500 mt-1">
                  {hasFolderHandle ? (
                    <span className="text-emerald-700 font-semibold flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>Đã liên kết thư mục <b>{folderName}</b>: Hệ thống sẽ tự động đọc/ghi các file JSON tín hiệu (<code>host_status.json</code>, <code>hello_*.json</code>, <code>offer_*.json</code>) để bắt tay WebRTC qua OneDrive.</span>
                    </span>
                  ) : (
                    <span>
                      💡 Hãy tạo thư mục <b>HR_Signaling_Data</b> (đặt cùng cấp với thư mục <code>dist</code> trong OneDrive) và bấm nút trên để Microsoft Edge tự động trao đổi file tín hiệu JSON.
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-100 flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    clusterService.saveConfig(clusterConfig);
                    success('Đã lưu cấu hình Cụm Node', 'Cấu hình mạng P2P WebRTC đã được lưu thành công.');
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl transition shadow-sm"
                >
                  <Save className="w-4 h-4 text-emerald-400" />
                  <span>Lưu Cấu Hình Node</span>
                </button>

                {clusterConfig.nodeRole === 'HOST' ? (
                  <button
                    onClick={async () => {
                      await clusterService.initializeNode('HOST', clusterConfig.nodeId, clusterConfig.displayName);
                      success('Đã khởi chạy Host', 'Máy chủ Kieu(Mia) đã sẵn sàng tiếp nhận RTCDataChannel từ 5 Client.');
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-bold text-xs rounded-xl transition shadow-md shadow-orange-200"
                  >
                    <Server className="w-4 h-4" />
                    <span>Khởi Chạy Máy Chủ Host (Kieu Master DB)</span>
                  </button>
                ) : (
                  <button
                    onClick={async () => {
                      await clusterService.initializeNode('CLIENT', clusterConfig.nodeId, clusterConfig.displayName);
                      success('Đang kết nối tới Host', 'Client đang phát tín hiệu kết nối tới Host Kiều qua mạng P2P.');
                    }}
                    className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-500 to-blue-500 hover:from-indigo-600 hover:to-blue-600 text-white font-bold text-xs rounded-xl transition shadow-md shadow-indigo-200"
                  >
                    <Radio className="w-4 h-4" />
                    <span>Bắt Đầu Kết Nối Tới Host Kieu</span>
                  </button>
                )}

                <button
                  onClick={() => setIsPairModalOpen(true)}
                  className="flex items-center gap-2 px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl transition shadow-xs border border-slate-300"
                  title="Ghép nối máy tính khi mở trực tiếp file:// mà không có web server"
                >
                  <Link2 className="w-4 h-4 text-indigo-600" />
                  <span>Ghép Nối Bằng Mã (Offline Token)</span>
                </button>
              </div>

              <button
                onClick={() => {
                  clusterService.disconnectAll();
                  success('Đã ngắt toàn bộ kết nối', 'Các kênh RTCDataChannel đã đóng an toàn.');
                }}
                className="px-3 py-2 text-slate-500 hover:text-rose-600 hover:bg-rose-50 font-semibold text-xs rounded-xl transition"
              >
                Ngắt Toàn Bộ Kết Nối
              </button>
            </div>
          </div>

          {/* Star Topology Visual Nodes Status */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h4 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Laptop className="w-4 h-4 text-indigo-600" />
                <span>Sơ Đồ Kết Nối 6 Máy Trong Cụm (Star-Topology Cluster)</span>
              </h4>
              <span className="text-xs font-semibold text-slate-500">Mô hình 1 Host Kieu + 5 Client</span>
            </div>

            {/* Host Card */}
            <div className="p-4 bg-gradient-to-r from-amber-50 to-orange-50 rounded-2xl border border-amber-200 flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-orange-500 text-white flex items-center justify-center font-black text-base shadow-md shadow-orange-200">
                  HOST
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-extrabold text-sm text-slate-900">Kieu(Mia) — System Admin</span>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-orange-200 text-orange-900 border border-orange-300">
                      MASTER DATABASE
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Nắm giữ toàn bộ dữ liệu gốc: Danh mục nhân sự, bảng chấm công, dữ liệu OT & nhật ký giao dịch
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {clusterConfig.nodeRole === 'HOST' ? (
                  <>
                    <span className={`w-3 h-3 rounded-full ${clusterStatus === 'CONNECTED' ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse`} />
                    <span className={`text-xs font-bold ${clusterStatus === 'CONNECTED' ? 'text-emerald-800' : 'text-amber-800'}`}>
                      {clusterStatus === 'CONNECTED' ? 'Host Đang Hoạt Động (Đã Bắt Tay Máy Trạm)' : 'Host Sẵn Sàng (Chờ Máy Trạm Kết Nối)'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className={`w-3 h-3 rounded-full ${
                      clusterStatus === 'CONNECTED' ? 'bg-emerald-500 animate-pulse' :
                      clusterStatus === 'SIGNALING' ? 'bg-indigo-500 animate-ping' :
                      clusterStatus === 'HOST_OFFLINE' ? 'bg-amber-500' : 'bg-slate-400'
                    }`} />
                    <span className={`text-xs font-bold ${
                      clusterStatus === 'CONNECTED' ? 'text-emerald-800' :
                      clusterStatus === 'SIGNALING' ? 'text-indigo-800' :
                      clusterStatus === 'HOST_OFFLINE' ? 'text-amber-800' : 'text-slate-600'
                    }`}>
                      {clusterStatus === 'CONNECTED' ? 'Host Kiều: Đã Kết Nối 🟢' :
                       clusterStatus === 'SIGNALING' ? 'Host Kiều: Đang Bắt Tay 🟡' :
                       clusterStatus === 'HOST_OFFLINE' ? 'Host Kiều: Chưa Bật (Lưu Cục Bộ) ⚪' : 'Host Kiều: Chờ Kết Nối'}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* 5 Clients Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {clusterConfig.nodes.map((node, idx) => (
                <div key={node.id} className="p-4 rounded-xl border border-slate-200 bg-slate-50/50 space-y-2 hover:bg-white hover:shadow-sm transition">
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded-md bg-slate-200 text-slate-700 text-[10px] font-black font-mono">
                      Client {idx + 1}: {node.id}
                    </span>
                    <span className="flex items-center gap-1.5 text-[11px] font-bold">
                      <span className={`w-2 h-2 rounded-full ${node.status === 'CONNECTED' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
                      <span className={node.status === 'CONNECTED' ? 'text-emerald-700' : 'text-slate-500'}>
                        {node.status === 'CONNECTED' ? `Online ${node.lastPing ? `(${node.lastPing})` : ''}` : 'Chờ kết nối'}
                      </span>
                    </span>
                  </div>

                  <div>
                    <h5 className="font-bold text-xs text-slate-900">{node.name}</h5>
                    <div className="text-[11px] text-slate-500">Tài khoản: <code className="font-mono text-slate-800 font-bold">{node.username}</code> ({node.role})</div>
                  </div>

                  <div className="pt-2 border-t border-slate-200/60">
                    <span className="text-[10px] text-slate-400 block font-semibold">Quyền gửi dữ liệu về Host:</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {node.allowedActions.map(action => (
                        <span key={action} className="px-1.5 py-0.5 rounded text-[9px] font-extrabold bg-blue-50 text-blue-700 border border-blue-100">
                          {action}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Detailed Handover Workflow Guide */}
          <div className="p-5 bg-slate-900 text-slate-200 rounded-2xl space-y-3 text-xs leading-relaxed">
            <h4 className="font-bold text-sm text-white flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Quy Trình Bàn Giao Từ Máy Glory Sang Máy Kieu Vận Hành</span>
            </h4>
            <div className="space-y-2 text-slate-300">
              <div className="flex items-start gap-2">
                <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono font-bold shrink-0">BƯỚC 1</span>
                <span><b>Glory build sản phẩm:</b> Máy Glory chạy <code>npm run build</code>, copy toàn bộ thư mục <code>dist/</code> sang thư mục OneDrive chung của công ty (ví dụ: <code>OneDrive - Leggett &amp; Platt/HR-System/dist</code>).</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono font-bold shrink-0">BƯỚC 2</span>
                <span><b>Kieu nhận bàn giao:</b> Trên máy Kieu, mở trực tiếp file <code>dist/index.html</code> bằng Microsoft Edge. Đăng nhập tài khoản <code>kieu</code> (mật khẩu mặc định <code>123</code>).</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono font-bold shrink-0">BƯỚC 3</span>
                <span><b>Kieu cấu hình làm HOST:</b> Vào menu <b>Cài Đặt &gt; Mạng P2P Cụm</b>, chọn vai trò là <b>HOST (Kieu Master DB)</b> và bấm <b>"Khởi Chạy Máy Chủ Host"</b>. Kieu nạp Master Data (Danh sách nhân viên, Bảng công).</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono font-bold shrink-0">BƯỚC 4</span>
                <span><b>5 Máy Client kết nối:</b> Vinh, Nguyet Anh, Han, Hoa và Glory mở Edge trên máy mình, đăng nhập tài khoản của họ, chọn vai trò <b>CLIENT</b>. Hai bên tự động thiết lập kênh truyền <b>RTCDataChannel</b> qua mạng LAN nội bộ. Mọi thao tác sắp ca và điền tỷ lệ được tự động đẩy về Master DB của Kieu.</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Ghép Nối WebRTC Thủ Công (Offline Token) */}
      {isPairModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full p-6 border border-slate-200 space-y-4 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Link2 className="w-5 h-5 text-indigo-600" />
                <h3 className="font-extrabold text-slate-900 text-sm">
                  Ghép Nối WebRTC P2P Bằng Mã Token (Offline)
                </h3>
              </div>
              <button
                onClick={() => {
                  setIsPairModalOpen(false);
                  setGeneratedPairToken('');
                  setInputPairToken('');
                  setHasCopiedPairToken(false);
                }}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-500 leading-relaxed">
              Dành cho môi trường mở trực tiếp file <code>dist/index.html</code> (không qua web server). Hai máy chỉ cần sao chép mã token qua ứng dụng chat nội bộ (Zalo, Teams, v.v.) để bắt tay RTCDataChannel tức thời.
            </p>

            {clusterConfig.nodeRole === 'HOST' ? (
              <div className="space-y-4">
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-2xl space-y-2">
                  <div className="text-xs font-bold text-amber-900 flex items-center justify-between">
                    <span>1. Chọn máy Client muốn kết nối:</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={pairClientId}
                      onChange={(e) => setPairClientId(e.target.value)}
                      className="px-3 py-1.5 bg-white border border-amber-300 rounded-xl text-xs font-bold text-slate-800 grow"
                    >
                      {clusterConfig.nodes.map(n => (
                        <option key={n.id} value={n.id}>{n.name} ({n.id})</option>
                      ))}
                    </select>
                    <button
                      onClick={async () => {
                        setIsPairWorking(true);
                        try {
                          const tok = await clusterService.createPairingOfferToken(pairClientId);
                          setGeneratedPairToken(tok);
                          success('Đã tạo mã kết nối Host', 'Vui lòng sao chép gửi cho Client.');
                        } catch (err: any) {
                          error('Lỗi tạo mã', err.message);
                        } finally {
                          setIsPairWorking(false);
                        }
                      }}
                      disabled={isPairWorking}
                      className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white font-bold text-xs rounded-xl transition shrink-0"
                    >
                      {isPairWorking ? 'Đang tạo...' : 'Tạo Mã Gửi Client'}
                    </button>
                  </div>
                </div>

                {generatedPairToken && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                      <span>Mã Token gửi máy Client:</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(generatedPairToken);
                          setHasCopiedPairToken(true);
                          setTimeout(() => setHasCopiedPairToken(false), 2000);
                          success('Đã sao chép mã token vào bộ nhớ tạm');
                        }}
                        className="flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-700 font-bold"
                      >
                        {hasCopiedPairToken ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{hasCopiedPairToken ? 'Đã sao chép' : 'Sao chép mã'}</span>
                      </button>
                    </div>
                    <textarea
                      readOnly
                      value={generatedPairToken}
                      rows={3}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-mono text-slate-700 break-all select-all"
                    />
                  </div>
                )}

                <div className="space-y-1.5 pt-2 border-t border-slate-100">
                  <label className="block text-xs font-bold text-slate-700">
                    2. Dán Mã Phản Hồi (Answer Token) từ Client gửi về:
                  </label>
                  <textarea
                    value={inputPairToken}
                    onChange={(e) => setInputPairToken(e.target.value)}
                    placeholder="Dán mã phản hồi do máy trạm Client tạo ra vào đây..."
                    rows={3}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-mono text-slate-800"
                  />
                  <button
                    onClick={async () => {
                      if (!inputPairToken.trim()) return;
                      setIsPairWorking(true);
                      try {
                        await clusterService.acceptAnswerToken(pairClientId, inputPairToken);
                        success('Kết nối thành công!', `Máy chủ Host đã bắt tay thành công với ${pairClientId}.`);
                        setIsPairModalOpen(false);
                      } catch (err: any) {
                        error('Lỗi nạp mã phản hồi', err.message);
                      } finally {
                        setIsPairWorking(false);
                      }
                    }}
                    disabled={isPairWorking || !inputPairToken.trim()}
                    className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl transition shadow-sm disabled:opacity-50"
                  >
                    {isPairWorking ? 'Đang bắt tay...' : 'Chốt Bắt Tay Kết Nối'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="block text-xs font-bold text-slate-700">
                    1. Dán Mã Token nhận được từ Host Kiều:
                  </label>
                  <textarea
                    value={inputPairToken}
                    onChange={(e) => setInputPairToken(e.target.value)}
                    placeholder="Dán mã token từ máy Host Kiều vào đây..."
                    rows={3}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-mono text-slate-800"
                  />
                  <button
                    onClick={async () => {
                      if (!inputPairToken.trim()) return;
                      setIsPairWorking(true);
                      try {
                        const ans = await clusterService.acceptOfferTokenAndCreateAnswer(inputPairToken);
                        setGeneratedPairToken(ans);
                        success('Đã tạo mã phản hồi!', 'Hãy sao chép mã này gửi lại cho Host Kiều để hoàn tất kết nối.');
                      } catch (err: any) {
                        error('Lỗi xử lý mã Host', err.message);
                      } finally {
                        setIsPairWorking(false);
                      }
                    }}
                    disabled={isPairWorking || !inputPairToken.trim()}
                    className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl transition shadow-sm disabled:opacity-50"
                  >
                    {isPairWorking ? 'Đang tạo mã phản hồi...' : 'Tạo Mã Phản Hồi Gửi Lại Cho Host'}
                  </button>
                </div>

                {generatedPairToken && (
                  <div className="space-y-1.5 pt-2 border-t border-slate-100">
                    <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                      <span>2. Mã phản hồi gửi lại cho Host Kiều:</span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(generatedPairToken);
                          setHasCopiedPairToken(true);
                          setTimeout(() => setHasCopiedPairToken(false), 2000);
                          success('Đã sao chép mã phản hồi vào bộ nhớ tạm');
                        }}
                        className="flex items-center gap-1 text-[11px] text-emerald-600 hover:text-emerald-700 font-bold"
                      >
                        {hasCopiedPairToken ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>{hasCopiedPairToken ? 'Đã sao chép' : 'Sao chép mã'}</span>
                      </button>
                    </div>
                    <textarea
                      readOnly
                      value={generatedPairToken}
                      rows={3}
                      className="w-full px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-xl text-[11px] font-mono text-emerald-900 break-all select-all"
                    />
                    <p className="text-[11px] text-emerald-700">
                      Sau khi Host Kiều dán mã này vào máy chủ, kênh RTCDataChannel sẽ lập tức mở và bạn sẽ thấy trạng thái chuyển sang màu xanh 🟢!
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
