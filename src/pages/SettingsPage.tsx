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
  Download
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';
import { RoleType, ISystemSettings } from '../types';
import { DEFAULT_SETTINGS, db } from '../db';
import { seedDatabaseIfEmpty } from '../services/db-seeder';
import { jsonSyncService, ScanResult, IngestResult } from '../services/json-sync-service';

export const SettingsPage: React.FC = () => {
  const { session, currentRole, systemSettings, refreshPermissions, hasPermission, changePassword } = useAuth();
  const { success, warning, error } = useToast();
  const { confirm } = useModal();

  const canManageRBAC = hasPermission('MANAGE_ROLES_PERMISSIONS');
  const canManageSystem = hasPermission('SYSTEM_SETTINGS');

  const [settings, setSettings] = useState<ISystemSettings>(systemSettings);

  // Đồng bộ thuần JSON qua thư mục OneDrive HR_Data (phương án A dual-master)
  const [hasSyncHandle, setHasSyncHandle] = useState(() => jsonSyncService.folder.hasHandle());
  const [isSyncGranted, setIsSyncGranted] = useState(() => jsonSyncService.folder.isGranted());
  const [syncFolderName, setSyncFolderName] = useState(() => jsonSyncService.folder.getFolderName());
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [ingestingFile, setIngestingFile] = useState<string | null>(null);
  const [lastIngest, setLastIngest] = useState<IngestResult | null>(null);

  React.useEffect(() => {
    return jsonSyncService.folder.onStatus((s) => {
      setHasSyncHandle(s.hasHandle);
      setSyncFolderName(s.folderName);
      setIsSyncGranted(s.granted);
    });
  }, []);

  React.useEffect(() => {
    if (!hasSyncHandle || !isSyncGranted) return;
    return jsonSyncService.startAutoScan((r) => setScanResult(r), 8000);
  }, [hasSyncHandle, isSyncGranted]);

  const handleConnectSyncFolder = async () => {
    try {
      const ok = await jsonSyncService.folder.connect();
      if (ok) {
        success('Đã liên kết thư mục', `Đã kết nối "${jsonSyncService.folder.getFolderName()}". Chỉ cần cấp quyền 1 lần.`);
        await handleScanNow();
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') error('Lỗi chọn thư mục', err?.message || 'Không thể liên kết.');
    }
  };

  const handleScanNow = async () => {
    setIsScanning(true);
    try {
      const r = await jsonSyncService.scanFolder();
      setScanResult(r);
    } catch (err: any) {
      error('Quét thất bại', err?.message || 'Không đọc được thư mục.');
    } finally {
      setIsScanning(false);
    }
  };

  const handleIngest = async (file: string, kind: 'dept' | 'master') => {
    if (!session) return;
    setIngestingFile(file);
    try {
      const res = kind === 'dept'
        ? await jsonSyncService.ingestDeptFile(file, { username: session.username, displayName: session.displayName })
        : await jsonSyncService.ingestMasterFile(file, { username: session.username, displayName: session.displayName });
      setLastIngest(res);
      if (res.blocked.length > 0) warning('Có NV bị chặn', `${res.note}. Chặn ${res.blocked.length} NV trùng ERP — cần xử lý tay.`);
      else if (res.conflicts.length > 0) warning('Có conflict', `${res.note}. Conflict ${res.conflicts.length} (auto kieu>hoa).`);
      else success('Tiếp nhận xong', `${res.note}. Áp dụng ${res.applied}.`);
      await handleScanNow();
    } catch (err: any) {
      error('Tiếp nhận thất bại', err?.message || 'Không merge được.');
    } finally {
      setIngestingFile(null);
    }
  };

  const handleExportMaster = async () => {
    if (!session) return;
    try {
      const { file, masterVersion } = await jsonSyncService.exportMasterFile(session.username);
      success('Đã xuất master', `File ${file} v${masterVersion} đã ghi vào HR_Data.`);
      await handleScanNow();
    } catch (err: any) {
      error('Xuất master thất bại', err?.message || 'Chỉ kieu/hoa mới xuất master.');
    }
  };

  const handleExportDept = async () => {
    if (!session) return;
    try {
      const { file, counts } = await jsonSyncService.exportDeptFile(session.username, session.displayName);
      success('Đã xuất file dept', `${file}: ${counts.shiftRosters} ca + ${counts.rates} rates.`);
      await handleScanNow();
    } catch (err: any) {
      error('Xuất dept thất bại', err?.message || 'Chỉ vinh/nguyetanh/han mới xuất dept.');
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

  const [activeTab, setActiveTab] = useState<'rbac' | 'diligence' | 'formula' | 'sync' | 'system'>('rbac');

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
          onClick={() => setActiveTab('sync')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition ${
            activeTab === 'sync'
              ? 'bg-slate-900 text-white shadow-sm'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <FileJson className="w-4 h-4 text-cyan-400" />
          <span>Đồng Bộ JSON (OneDrive HR_Data)</span>
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

      {/* Tab: Đồng bộ JSON thuần qua OneDrive HR_Data (phương án A) */}
      {activeTab === 'sync' && (
        <div className="space-y-6">
          <div className="bg-gradient-to-r from-emerald-950 via-teal-900 to-emerald-950 text-white p-6 rounded-2xl border border-emerald-800/50 shadow-xl">
            <h3 className="text-base font-bold flex items-center gap-2">
              <FileJson className="w-5 h-5 text-emerald-300" />
              <span>Đồng Bộ Thuần JSON — 2 Master (kieu + hoa) + 3 File Dept Riêng</span>
            </h3>
            <p className="text-xs text-emerald-100/80 mt-1">
              Không realtime RTC. Mỗi user chỉ ghi file của mình. kieu/hoa quét + merge LWW (kieu &gt; hoa khi cùng giờ). NV không bao giờ bị xóa khi merge.
            </p>
            <div className="mt-3 p-3 bg-white/5 rounded-xl border border-white/10 text-xs font-mono">
              HR_Data/ master_kieu.json · master_hoa.json · dept_WH_vinh.json · dept_QC_nguyetanh.json · dept_PRD_han.json
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100 flex-wrap gap-2">
              <h4 className="text-sm font-bold text-slate-900">Thư mục đồng bộ (cấp quyền 1 lần)</h4>
              <span className="text-xs text-slate-400">Handle lưu IndexedDB — lần sau chỉ 1 click</span>
            </div>
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span className={`px-2.5 py-1 rounded-full font-bold border ${hasSyncHandle && isSyncGranted ? 'bg-emerald-50 text-emerald-800 border-emerald-300' : 'bg-amber-50 text-amber-800 border-amber-300'}`}>
                {hasSyncHandle && isSyncGranted ? `Đã kết nối: ${syncFolderName}` : hasSyncHandle ? `Cần cấp quyền: ${syncFolderName}` : 'Chưa chọn thư mục HR_Data'}
              </span>
              <button onClick={handleConnectSyncFolder} className="flex items-center gap-1.5 px-4 py-2 rounded-xl font-bold bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 transition">
                <Folder className="w-4 h-4 text-amber-500" />
                <span>{hasSyncHandle && !isSyncGranted ? 'Cấp Quyền (1 click)' : 'Chọn Thư Mục HR_Data'}</span>
              </button>
              <button onClick={handleScanNow} disabled={isScanning || !isSyncGranted} className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl transition disabled:opacity-50">
                {isScanning ? 'Đang quét...' : 'Quét Ngay'}
              </button>
            </div>
            {!hasSyncHandle && (
              <p className="text-[11px] text-slate-500">Tạo thư mục <b>HR_Data</b> trong OneDrive dùng chung, bấm nút trên 1 lần duy nhất trên mỗi máy.</p>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3">
              <h4 className="text-sm font-bold text-slate-900">Xuất dữ liệu của tôi</h4>
              {session && jsonSyncService.isMasterUser(session.username) ? (
                <div className="space-y-2 text-xs">
                  <p className="text-slate-500">kieu/hoa xuất toàn bộ master (tăng version, không đè file nhau).</p>
                  <button onClick={handleExportMaster} className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 text-white font-bold rounded-xl shadow-sm">
                    <Upload className="w-4 h-4" /><span>Xuất Master Của Tôi</span>
                  </button>
                </div>
              ) : session && jsonSyncService.getDeptFilename(session.username) ? (
                <div className="space-y-2 text-xs">
                  <p className="text-slate-500">Dept Admin chỉ xuất file dept thuộc phòng mình.</p>
                  <button onClick={handleExportDept} className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-orange-500 to-amber-500 text-white font-bold rounded-xl shadow-sm">
                    <Upload className="w-4 h-4" /><span>Xuất File Dept Của Tôi</span>
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-500">Tài khoản hiện tại không thuộc nhóm sync dept/master.</p>
              )}
              <div className="pt-2 border-t border-slate-100 text-[11px] text-slate-500">
                Fallback không cần thư mục: dùng nút tải file / upload trong Header (Quét JSON) khi OneDrive chưa kịp sync.
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3">
              <h4 className="text-sm font-bold text-slate-900">File chờ xử lý</h4>
              {!scanResult ? (
                <p className="text-xs text-slate-500">Bấm “Quét Ngay” để liệt kê file dept/master mới.</p>
              ) : (scanResult.pendingDept.length + scanResult.pendingMaster.length === 0 && scanResult.conflictCopies.length === 0) ? (
                <p className="text-xs text-emerald-700 font-semibold flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> Đã đồng bộ, không có file mới.</p>
              ) : (
                <div className="space-y-2 max-h-[260px] overflow-y-auto">
                  {scanResult.pendingDept.map((it) => (
                    <div key={it.file} className="p-2.5 border border-slate-200 rounded-xl flex items-center justify-between gap-2 text-xs">
                      <div><div className="font-mono font-bold">{it.file}</div><div className="text-slate-500">{it.note}</div></div>
                      <button disabled={ingestingFile === it.file} onClick={() => handleIngest(it.file, 'dept')} className="px-3 py-1.5 bg-emerald-600 text-white font-bold rounded-xl disabled:opacity-50 shrink-0">
                        {ingestingFile === it.file ? '...' : 'Tiếp Nhận'}
                      </button>
                    </div>
                  ))}
                  {scanResult.pendingMaster.map((it) => (
                    <div key={it.file} className="p-2.5 border border-indigo-200 bg-indigo-50/50 rounded-xl flex items-center justify-between gap-2 text-xs">
                      <div><div className="font-mono font-bold text-indigo-900">{it.file}</div><div className="text-slate-500">{it.note}</div></div>
                      <button disabled={ingestingFile === it.file} onClick={() => handleIngest(it.file, 'master')} className="px-3 py-1.5 bg-indigo-600 text-white font-bold rounded-xl disabled:opacity-50 shrink-0">
                        {ingestingFile === it.file ? '...' : 'Merge'}
                      </button>
                    </div>
                  ))}
                  {scanResult.conflictCopies.map((f) => (
                    <div key={f} className="p-2.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-[11px] font-semibold">Conflict copy: <code className="font-mono">{f}</code> — nhờ kieu xử lý tay.</div>
                  ))}
                </div>
              )}
              {lastIngest && (
                <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-[11px] text-slate-600">
                  Lần nhận gần nhất: <b>{lastIngest.file}</b> — áp dụng {lastIngest.applied}, bỏ qua {lastIngest.skipped}, conflict {lastIngest.conflicts.length}, chặn {lastIngest.blocked.length}.
                  {lastIngest.blocked.slice(0, 3).map((b) => (<div key={b.pk} className="text-rose-700">• {b.reason}</div>))}
                </div>
              )}
            </div>
          </div>

          <div className="p-5 bg-amber-50/60 border border-amber-200 rounded-2xl text-xs text-amber-900 space-y-1.5">
            <p className="font-bold">An toàn NV cũ/mới (bắt buộc):</p>
            <p>• employeeId bất biến, cấm tái sử dụng. Nghỉ việc chỉ đổi status RESIGNED, không xóa.</p>
            <p>• NV mới trùng mã ERP bị chặn tự động, kieu xử lý tay.</p>
            <p>• Ai sửa được truy vết qua _sync.by + nhật ký audit (TIMESHEET_EDIT / ASSIGN_SHIFT / UPDATE_RATE_*).</p>
            <p>• han (NS) và nguyetanh (CL) sửa cùng ngày-line không mất nhau nhờ merge theo field.</p>
          </div>
        </div>
      )}

    </div>
  );
};