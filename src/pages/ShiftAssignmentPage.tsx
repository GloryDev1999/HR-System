import React, { useState, useMemo } from 'react';
import {
  Briefcase,
  Search,
  CheckSquare,
  Square,
  Save,
  RotateCcw,
  Filter,
  CalendarDays,
  Users,
  AlertTriangle,
  Inbox,
  Send,
  CheckCircle2,
  Clock,
  Calendar,
  Eye,
  Edit3,
  CheckCheck,
  Building2,
  Sparkles,
  RefreshCw
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { ShiftClassType, IEmployee } from '../types';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { logUserAction } from '../services/audit-log-service';
import { clusterService } from '../services/webrtc-cluster-service';

/**
 * Sắp Xếp Ca Làm Việc & Tiếp Nhận Sắp Ca Từ Các Trạm (Local-First WebRTC Cluster)
 * - Đối với Host Kiều & Hoa (HR): Mặc định là màn hình "Tiếp Nhận Dữ Liệu Sắp Ca" từ 3 trạm:
 *     1. Kho WH (Vinh)
 *     2. Quản Lý QC (Nguyệt Ánh)
 *     3. Sản Xuất / Production (Hân)
 *   Cho phép theo dõi tiến độ nộp ca, số lượng nhân viên, phát hiện vi phạm nghỉ 12h, đối soát ma trận ca.
 *   Có nút chuyển sang chế độ sắp ca thủ công khi HR muốn can thiệp trực tiếp.
 * - Đối với các máy trạm Client (Vinh, Nguyệt Ánh, Hân):
 *   Giao diện sắp ca cho nhân viên thuộc bộ phận mình quản lý.
 *   Khi bấm "Lưu & Gửi Dữ Liệu Sắp Ca Lên Host", hệ thống lưu local DB và lập tức truyền
 *   dữ liệu qua kênh WebRTC RTCDataChannel (hoặc dự phòng qua OneDrive HR_Signaling_Data) tới Host Kiều.
 */

const SHIFT_ELIGIBLE_DEPARTMENTS: string[] = ['Production', 'QC', 'WH'];
const OFFICE_EXCLUDED_SHIFT: ShiftClassType = 'OFFICE_M_F';

const SHIFT_OPTIONS: { value: ShiftClassType; label: string; time: string; color: string }[] = [
  { value: 'SHIFT_1', label: 'Ca 1', time: '06:00 - 14:00', color: 'bg-blue-100 text-blue-800 border-blue-200' },
  { value: 'SHIFT_2', label: 'Ca 2', time: '14:00 - 22:00', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  { value: 'OFFICE_M_S', label: 'HC (T2-T7)', time: '07:30 - 16:00', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
];

function getShiftTime(shift: ShiftClassType): { start: string; end: string } {
  switch (shift) {
    case 'SHIFT_1': return { start: '06:00', end: '14:00' };
    case 'SHIFT_2': return { start: '14:00', end: '22:00' };
    case 'OFFICE_M_F':
    case 'OFFICE_M_S':
      return { start: '07:30', end: '16:00' };
    default: return { start: '06:00', end: '14:00' };
  }
}

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(dateStr: string, days: number): string {
  const d = parseDateStr(dateStr);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

function getDateRange(mode: 'day' | 'week' | 'month', baseDateStr: string): string[] {
  if (mode === 'day') return [baseDateStr];
  if (mode === 'week') {
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) dates.push(addDays(baseDateStr, i));
    return dates;
  }
  const d = parseDateStr(baseDateStr);
  const y = d.getFullYear();
  const m = d.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const dates: string[] = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const dd = new Date(y, m, day);
    dates.push(toDateStr(dd));
  }
  return dates;
}

export const ShiftAssignmentPage: React.FC = () => {
  const { session, departmentScope, hasPermission, currentRole } = useAuth();
  const { success, warning, error, info } = useToast();

  const isHostOrHR = (
    session?.username?.toLowerCase() === 'kieu' ||
    session?.username?.toLowerCase() === 'hoa' ||
    currentRole === 'HR Manager'
  );

  // Chế độ xem: Host Kiều và Hoa mặc định ở chế độ 'received' (Tiếp nhận ca từ các trạm)
  // Các máy trạm con (Vinh, Nguyệt Ánh, Hân) mặc định ở chế độ 'manual' (Sắp xếp ca cho bộ phận mình)
  const [viewMode, setViewMode] = useState<'received' | 'manual'>(isHostOrHR ? 'received' : 'manual');

  // Bộ lọc cho chế độ tiếp nhận (Host/HR review)
  const [selectedDeptReview, setSelectedDeptReview] = useState<string>('ALL');

  // Trạng thái cho chế độ sắp ca thủ công
  const [searchManualTerm, setSearchManualTerm] = useState('');
  const [searchReviewTerm, setSearchReviewTerm] = useState('');
  const [selectedDept, setSelectedDept] = useState<string>(departmentScope || 'Production');
  const [mode, setMode] = useState<'day' | 'week' | 'month'>('day');
  const [baseDate, setBaseDate] = useState<string>(toDateStr(new Date()));
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<Set<string>>(new Set());
  const [shiftSelections, setShiftSelections] = useState<Record<string, ShiftClassType>>({});
  const [bulkShift, setBulkShift] = useState<ShiftClassType>('SHIFT_1');
  const [isSubmittingToHost, setIsSubmittingToHost] = useState(false);

  // Live queries từ Dexie
  const employees = useLiveQuery(() => db.employees.toArray(), []) || [];
  const shiftRosters = useLiveQuery(() => db.shiftRosters.toArray(), []) || [];
  const shiftSubmissionsSetting = useLiveQuery(() => db.settings.get('shift_submissions'), []);
  const shiftSubmissions: any[] = shiftSubmissionsSetting?.value || [];

  // Thống kê tiến độ nộp ca của 3 bộ phận trọng yếu theo ngày được chọn (baseDate)
  const deptStats = useMemo(() => {
    const getDeptInfo = (dept: string, adminName: string, adminUser: string) => {
      const deptEmployees = employees.filter(e => e.department === dept && e.shiftClassId !== OFFICE_EXCLUDED_SHIFT);
      // Lọc chính xác theo ngày đang đối soát (baseDate) để số liệu không bị cộng dồn toàn thời gian
      const deptRosters = shiftRosters.filter(r => r.department === dept && (!baseDate || r.date === baseDate));
      const assignedEmpIds = new Set(deptRosters.map(r => r.employeeId));
      const shift1 = deptRosters.filter(r => r.shiftCode === 'SHIFT_1').length;
      const shift2 = deptRosters.filter(r => r.shiftCode === 'SHIFT_2').length;
      const office = deptRosters.filter(r => r.shiftCode === 'OFFICE_M_S' || r.shiftCode === 'OFFICE_M_F').length;
      const violations = deptRosters.filter(r => r.isRestViolation).length;
      const latestSub = shiftSubmissions.find(s => s.department === dept);

      return {
        dept,
        adminName,
        adminUser,
        totalEmployees: deptEmployees.length,
        assignedEmployeesCount: assignedEmpIds.size,
        totalRostersCount: deptRosters.length,
        shift1Count: shift1,
        shift2Count: shift2,
        officeCount: office,
        violationsCount: violations,
        latestSubmission: latestSub
      };
    };

    return {
      wh: getDeptInfo('WH', 'Vinh (Warehouse Admin)', 'vinh'),
      qc: getDeptInfo('QC', 'Nguyệt Ánh (QC Admin)', 'nguyetanh'),
      prd: getDeptInfo('Production', 'Hân (Production Admin)', 'han'),
    };
  }, [employees, shiftRosters, shiftSubmissions, baseDate]);

  // Danh sách nhân viên trong chế độ sắp ca thủ công
  const visibleEmployees = useMemo(() => {
    let list = employees;
    list = list.filter(e => e.shiftClassId !== OFFICE_EXCLUDED_SHIFT);
    list = list.filter(e => SHIFT_ELIGIBLE_DEPARTMENTS.includes(e.department));
    if (departmentScope) {
      list = list.filter(e => e.department === departmentScope);
    } else if (selectedDept !== 'ALL') {
      list = list.filter(e => e.department === selectedDept);
    }
    if (searchManualTerm) {
      const q = searchManualTerm.toLowerCase();
      list = list.filter(e => e.employeeId.toLowerCase().includes(q) || e.fullName.toLowerCase().includes(q));
    }
    return list;
  }, [employees, departmentScope, selectedDept, searchManualTerm]);

  // Lấy ca hiện tại cho mỗi NV vào ngày baseDate
  const currentShiftMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of shiftRosters) {
      if (r.date === baseDate) {
        map.set(r.employeeId, r.shiftCode);
      }
    }
    return map;
  }, [shiftRosters, baseDate]);

  // Danh sách các bản ghi ca được lọc để Host/HR đối soát
  const reviewRosters = useMemo(() => {
    return shiftRosters.filter(r => {
      if (selectedDeptReview !== 'ALL' && r.department !== selectedDeptReview) return false;
      if (baseDate && r.date !== baseDate) return false;
      if (searchReviewTerm) {
        const q = searchReviewTerm.toLowerCase();
        if (!r.employeeId.toLowerCase().includes(q) && !r.fullName.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [shiftRosters, selectedDeptReview, baseDate, searchReviewTerm]);

  const toggleSelectAll = () => {
    if (selectedEmployeeIds.size === visibleEmployees.length) {
      setSelectedEmployeeIds(new Set());
    } else {
      setSelectedEmployeeIds(new Set(visibleEmployees.map(e => e.employeeId)));
    }
  };

  const toggleSelectOne = (empId: string) => {
    const next = new Set(selectedEmployeeIds);
    if (next.has(empId)) next.delete(empId);
    else next.add(empId);
    setSelectedEmployeeIds(next);
  };

  const handleBulkApply = () => {
    if (selectedEmployeeIds.size === 0) {
      warning('Chưa chọn nhân viên', 'Vui lòng chọn ít nhất 1 nhân viên để áp dụng ca.');
      return;
    }
    const next: Record<string, ShiftClassType> = { ...shiftSelections };
    selectedEmployeeIds.forEach(id => {
      next[id] = bulkShift;
    });
    setShiftSelections(next);
    info('Đã áp dụng ca hàng loạt', `Đã gán ${bulkShift} cho ${selectedEmployeeIds.size} nhân viên đã chọn. Bấm "Lưu & Gửi Lên Host" để đồng bộ.`);
  };

  // Lưu ca & Đồng bộ lên Host Kiều
  const handleSaveAndSync = async () => {
    if (!hasPermission('MANAGE_ROSTER') && !hasPermission('MANAGE_DEPT_ROSTER')) {
      error('Không đủ quyền', 'Bạn không có quyền sắp xếp ca (MANAGE_ROSTER).');
      return;
    }
    const entries = Object.entries(shiftSelections).filter(([empId]) => visibleEmployees.some(e => e.employeeId === empId));
    if (entries.length === 0) {
      warning('Chưa chọn ca', 'Vui lòng chọn ca cho ít nhất 1 nhân viên.');
      return;
    }

    const dateRange = getDateRange(mode, baseDate);
    const toSave: import('../types').IShiftRosterEntry[] = [];

    for (const [empId, shiftCode] of entries) {
      const emp = employees.find(e => e.employeeId === empId);
      if (!emp) continue;
      const { start, end } = getShiftTime(shiftCode);
      for (const dateStr of dateRange) {
        const prevDate = addDays(dateStr, -1);
        const prevRoster = toSave.find(r => r.employeeId === empId && r.date === prevDate)
          || shiftRosters.find(r => r.employeeId === empId && r.date === prevDate);
        const prevEnd = prevRoster?.endTime;
        let isViolating = false;
        let restHours = 16;
        let violationDetails: string | undefined;

        if (prevEnd && start) {
          try {
            const prevEndIso = `${prevDate}T${prevEnd.length === 5 ? prevEnd : prevEnd.slice(0, 5)}:00`;
            const curStartIso = `${dateStr}T${start.length === 5 ? start : start.slice(0, 5)}:00`;
            const diffMs = new Date(curStartIso).getTime() - new Date(prevEndIso).getTime();
            if (!isNaN(diffMs) && diffMs > 0) {
              restHours = Math.round((diffMs / (1000 * 60 * 60)) * 10) / 10;
              if (restHours < 12) {
                isViolating = true;
                violationDetails = `Nghỉ ${restHours}h giữa ca trước (${prevEnd}) và ca mới (${start}) < 12h theo quy định BLLĐ`;
              }
            }
          } catch {
            restHours = 16;
          }
        }

        toSave.push({
          employeeId_date: `${empId}_${dateStr}`,
          employeeId: empId,
          fullName: emp.fullName,
          department: emp.department,
          date: dateStr,
          shiftCode,
          startTime: start,
          endTime: end,
          previousShiftEndTime: prevEnd,
          restHours,
          isRestViolation: isViolating,
          isRestViolationFlag: isViolating ? 1 : 0,
          violationDetails,
        });
      }
    }

    setIsSubmittingToHost(true);
    try {
      // 1. Lưu vào Database cục bộ (Local-First)
      await db.transaction('rw', db.shiftRosters, db.employees, async () => {
        await db.shiftRosters.bulkPut(toSave);
        for (const [empId, shiftCode] of entries) {
          await db.employees.update(empId, { shiftClassId: shiftCode });
        }
      });

      // 2. Nếu là máy Client, truyền đợt sắp ca này lên máy chủ Host Kiều
      const targetDept = departmentScope || selectedDept;
      if (!isHostOrHR) {
        const syncRes = await clusterService.sendShiftBatchToHost({
          department: targetDept,
          rosters: toSave,
          entries,
          dateRange,
          username: session?.username,
          displayName: session?.displayName
        });

        if (syncRes.sentViaWebRTC) {
          success(
            'Đã gửi trực tiếp lên Host Kiều',
            `Kênh WebRTC P2P đã truyền thành công ${toSave.length} ca làm việc (${entries.length} NV) lên máy chủ Host Kiều tức thời!`
          );
        } else if (syncRes.sentViaFolder) {
          success(
            'Đã đồng bộ qua OneDrive',
            `Đã lưu file nộp ca shifts_${clusterService.getConfig().nodeId}.json vào thư mục HR_Signaling_Data. Host Kiều sẽ tự động nạp khi quét!`
          );
        } else {
          info(
            'Đã lưu cục bộ an toàn',
            `Đã lưu ${toSave.length} ca làm việc trên máy trạm. Dữ liệu sẽ tự động đồng bộ khi bạn kết nối tới Host Kiều.`
          );
        }
      } else {
        success(
          'Đã lưu ca trên Master DB',
          `Đã lưu thành công ${toSave.length} ca làm việc (${entries.length} NV × ${dateRange.length} ngày) vào cơ sở dữ liệu trung tâm.`
        );
      }

      if (session) {
        logUserAction({
          username: session.username,
          displayName: session.displayName,
          role: session.role,
          actionType: 'ASSIGN_SHIFT',
          targetEntity: `${targetDept} (${entries.length} NV, ${toSave.length} ca)`,
          details: `Sắp ca ${dateRange[0]} -> ${dateRange[dateRange.length - 1]} và gửi đồng bộ sang Host Kiều`
        }).catch(console.error);
      }
    } catch (err: any) {
      error('Lỗi lưu ca', err.message);
    } finally {
      setIsSubmittingToHost(false);
    }
  };

  const canManage = hasPermission('MANAGE_ROSTER') || hasPermission('MANAGE_DEPT_ROSTER');

  return (
    <div className="p-6 w-full space-y-6 flex-1 flex flex-col font-sans">
      {/* Header Banner */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-xl ${isHostOrHR ? 'bg-indigo-100 text-indigo-700' : 'bg-orange-100 text-orange-600'}`}>
              {isHostOrHR ? <Inbox className="w-5 h-5" /> : <Briefcase className="w-5 h-5" />}
            </div>
            <div>
              <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
                <span>{isHostOrHR && viewMode === 'received' ? 'Tiếp Nhận Dữ Liệu Sắp Ca Từ Các Trạm' : 'Sắp Xếp Ca Làm Việc'}</span>
                {isHostOrHR && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                    Host & HR Management
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {isHostOrHR && viewMode === 'received'
                  ? 'Theo dõi, đối soát và tiếp nhận dữ liệu phân ca tự động từ 3 trạm: Kho WH (Vinh), Quản Lý QC (Nguyệt Ánh), Sản Xuất (Hân).'
                  : 'Sắp ca cho nhân viên theo ngày/tuần/tháng. Dữ liệu sẽ được tự động gửi và đồng bộ sang máy chủ Host Kiều.'}
              </p>
            </div>
          </div>
        </div>

        {/* Nút chuyển chế độ đối với Host Kiều / Hoa */}
        <div className="flex items-center gap-2">
          {isHostOrHR && (
            <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200 text-xs">
              <button
                onClick={() => setViewMode('received')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold transition ${
                  viewMode === 'received'
                    ? 'bg-white text-indigo-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Inbox className="w-3.5 h-3.5" />
                <span>Tiếp Nhận Từ Trạm</span>
              </button>
              <button
                onClick={() => setViewMode('manual')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold transition ${
                  viewMode === 'manual'
                    ? 'bg-white text-orange-600 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Edit3 className="w-3.5 h-3.5" />
                <span>Sắp Ca Thủ Công</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* VIEW MODE 1: HOST / HR TIẾP NHẬN DỮ LIỆU SẮP CA TỪ CÁC TRẠM               */}
      {/* ========================================================================= */}
      {isHostOrHR && viewMode === 'received' ? (
        <div className="space-y-6 flex-1 flex flex-col">
          {/* Thẻ tiến độ 3 Bộ phận nộp ca */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* 1. Kho WH (Vinh) */}
            <div
              onClick={() => setSelectedDeptReview('WH')}
              className={`p-4 rounded-2xl border transition cursor-pointer shadow-xs ${
                selectedDeptReview === 'WH'
                  ? 'bg-amber-50/70 border-amber-400 ring-2 ring-amber-300'
                  : 'bg-white border-slate-200 hover:border-amber-300'
              }`}
            >
              <div className="flex items-start justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-amber-100 text-amber-800 rounded-xl">
                    <Building2 className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 text-xs">Kho WH (Vinh)</h3>
                    <p className="text-[11px] text-slate-500">Người phụ trách: Vinh (Warehouse)</p>
                  </div>
                </div>
                {deptStats.wh.totalRostersCount > 0 ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Đã nộp ca
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500">
                    Chưa nộp
                  </span>
                )}
              </div>

              <div className="pt-3 space-y-2 text-xs">
                <div className="flex justify-between items-center text-slate-600">
                  <span>Tổng nhân viên đi ca:</span>
                  <span className="font-bold text-slate-900">{deptStats.wh.assignedEmployeesCount} / {deptStats.wh.totalEmployees} NV</span>
                </div>
                <div className="flex justify-between items-center text-slate-600">
                  <span>Tổng số ca đã gán:</span>
                  <span className="font-bold text-indigo-700">{deptStats.wh.totalRostersCount} ca</span>
                </div>
                <div className="flex items-center gap-2 pt-1 text-[11px]">
                  <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold">Ca 1: {deptStats.wh.shift1Count}</span>
                  <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-semibold">Ca 2: {deptStats.wh.shift2Count}</span>
                  <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold">HC: {deptStats.wh.officeCount}</span>
                </div>
                <div className="pt-2 border-t border-slate-100 flex justify-between items-center text-[11px]">
                  <span className="text-slate-500">Vi phạm nghỉ 12h:</span>
                  {deptStats.wh.violationsCount > 0 ? (
                    <span className="font-bold text-rose-600 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" /> {deptStats.wh.violationsCount} vi phạm
                    </span>
                  ) : (
                    <span className="font-bold text-emerald-600 flex items-center gap-1">
                      <CheckCheck className="w-3.5 h-3.5" /> 0 vi phạm (Chuẩn)
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* 2. Quản Lý QC (Nguyệt Ánh) */}
            <div
              onClick={() => setSelectedDeptReview('QC')}
              className={`p-4 rounded-2xl border transition cursor-pointer shadow-xs ${
                selectedDeptReview === 'QC'
                  ? 'bg-blue-50/70 border-blue-400 ring-2 ring-blue-300'
                  : 'bg-white border-slate-200 hover:border-blue-300'
              }`}
            >
              <div className="flex items-start justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-blue-100 text-blue-800 rounded-xl">
                    <Building2 className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 text-xs">Quản Lý QC (Nguyệt Ánh)</h3>
                    <p className="text-[11px] text-slate-500">Người phụ trách: Nguyệt Ánh (QC Admin)</p>
                  </div>
                </div>
                {deptStats.qc.totalRostersCount > 0 ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Đã nộp ca
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500">
                    Chưa nộp
                  </span>
                )}
              </div>

              <div className="pt-3 space-y-2 text-xs">
                <div className="flex justify-between items-center text-slate-600">
                  <span>Tổng nhân viên đi ca:</span>
                  <span className="font-bold text-slate-900">{deptStats.qc.assignedEmployeesCount} / {deptStats.qc.totalEmployees} NV</span>
                </div>
                <div className="flex justify-between items-center text-slate-600">
                  <span>Tổng số ca đã gán:</span>
                  <span className="font-bold text-indigo-700">{deptStats.qc.totalRostersCount} ca</span>
                </div>
                <div className="flex items-center gap-2 pt-1 text-[11px]">
                  <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold">Ca 1: {deptStats.qc.shift1Count}</span>
                  <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-semibold">Ca 2: {deptStats.qc.shift2Count}</span>
                  <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold">HC: {deptStats.qc.officeCount}</span>
                </div>
                <div className="pt-2 border-t border-slate-100 flex justify-between items-center text-[11px]">
                  <span className="text-slate-500">Vi phạm nghỉ 12h:</span>
                  {deptStats.qc.violationsCount > 0 ? (
                    <span className="font-bold text-rose-600 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" /> {deptStats.qc.violationsCount} vi phạm
                    </span>
                  ) : (
                    <span className="font-bold text-emerald-600 flex items-center gap-1">
                      <CheckCheck className="w-3.5 h-3.5" /> 0 vi phạm (Chuẩn)
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* 3. Sản Xuất / Production (Hân) */}
            <div
              onClick={() => setSelectedDeptReview('Production')}
              className={`p-4 rounded-2xl border transition cursor-pointer shadow-xs ${
                selectedDeptReview === 'Production'
                  ? 'bg-purple-50/70 border-purple-400 ring-2 ring-purple-300'
                  : 'bg-white border-slate-200 hover:border-purple-300'
              }`}
            >
              <div className="flex items-start justify-between pb-3 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <div className="p-2 bg-purple-100 text-purple-800 rounded-xl">
                    <Building2 className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 text-xs">Sản Xuất / Production (Hân)</h3>
                    <p className="text-[11px] text-slate-500">Người phụ trách: Hân (Production Admin)</p>
                  </div>
                </div>
                {deptStats.prd.totalRostersCount > 0 ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-100 text-emerald-800 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3" /> Đã nộp ca
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500">
                    Chưa nộp
                  </span>
                )}
              </div>

              <div className="pt-3 space-y-2 text-xs">
                <div className="flex justify-between items-center text-slate-600">
                  <span>Tổng nhân viên đi ca:</span>
                  <span className="font-bold text-slate-900">{deptStats.prd.assignedEmployeesCount} / {deptStats.prd.totalEmployees} NV</span>
                </div>
                <div className="flex justify-between items-center text-slate-600">
                  <span>Tổng số ca đã gán:</span>
                  <span className="font-bold text-indigo-700">{deptStats.prd.totalRostersCount} ca</span>
                </div>
                <div className="flex items-center gap-2 pt-1 text-[11px]">
                  <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-semibold">Ca 1: {deptStats.prd.shift1Count}</span>
                  <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-semibold">Ca 2: {deptStats.prd.shift2Count}</span>
                  <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-semibold">HC: {deptStats.prd.officeCount}</span>
                </div>
                <div className="pt-2 border-t border-slate-100 flex justify-between items-center text-[11px]">
                  <span className="text-slate-500">Vi phạm nghỉ 12h:</span>
                  {deptStats.prd.violationsCount > 0 ? (
                    <span className="font-bold text-rose-600 flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" /> {deptStats.prd.violationsCount} vi phạm
                    </span>
                  ) : (
                    <span className="font-bold text-emerald-600 flex items-center gap-1">
                      <CheckCheck className="w-3.5 h-3.5" /> 0 vi phạm (Chuẩn)
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Thanh lọc & tìm kiếm ca đã nhận */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              {/* Lọc bộ phận */}
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl text-xs font-bold">
                <button
                  onClick={() => setSelectedDeptReview('ALL')}
                  className={`px-3 py-1.5 rounded-lg transition ${selectedDeptReview === 'ALL' ? 'bg-white shadow-xs text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  Toàn Bộ Nhà Máy
                </button>
                <button
                  onClick={() => setSelectedDeptReview('WH')}
                  className={`px-3 py-1.5 rounded-lg transition ${selectedDeptReview === 'WH' ? 'bg-white shadow-xs text-amber-800' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  Kho WH
                </button>
                <button
                  onClick={() => setSelectedDeptReview('QC')}
                  className={`px-3 py-1.5 rounded-lg transition ${selectedDeptReview === 'QC' ? 'bg-white shadow-xs text-blue-800' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  QC
                </button>
                <button
                  onClick={() => setSelectedDeptReview('Production')}
                  className={`px-3 py-1.5 rounded-lg transition ${selectedDeptReview === 'Production' ? 'bg-white shadow-xs text-purple-800' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  Sản Xuất
                </button>
              </div>

              {/* Lọc ngày */}
              <div className="flex items-center gap-1.5 text-xs text-slate-600 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-xl">
                <CalendarDays className="w-4 h-4 text-slate-500" />
                <span>Ngày áp dụng:</span>
                <input
                  type="date"
                  value={baseDate}
                  onChange={(e) => setBaseDate(e.target.value)}
                  className="bg-transparent font-bold text-slate-900 focus:outline-none text-xs"
                />
              </div>

              {/* Tìm kiếm */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchReviewTerm}
                  onChange={(e) => setSearchReviewTerm(e.target.value)}
                  placeholder="Tìm mã NV, tên NV..."
                  className="pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs w-48 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="text-xs text-slate-500">
              Tìm thấy <b className="text-indigo-700 font-bold">{reviewRosters.length}</b> ca trong ngày {baseDate}
            </div>
          </div>

          {/* Bảng chi tiết các ca đã nhận vào Master DB */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex-1">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-4">Mã NV</th>
                    <th className="py-3 px-4">Họ và Tên</th>
                    <th className="py-3 px-4">Bộ Phận</th>
                    <th className="py-3 px-4 text-center">Ngày Làm Việc</th>
                    <th className="py-3 px-4 text-center">Ca Được Gán</th>
                    <th className="py-3 px-4 text-center">Khung Giờ</th>
                    <th className="py-3 px-4 text-center">Nghỉ Giữa 2 Ca</th>
                    <th className="py-3 px-4 text-center">Kiểm Soát Vi Phạm</th>
                    <th className="py-3 px-4 text-center">Trạng Thái</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {reviewRosters.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-10 text-center text-slate-400">
                        Chưa có dữ liệu phân ca cho ngày {baseDate} (Bộ phận: {selectedDeptReview}).
                      </td>
                    </tr>
                  ) : (
                    reviewRosters.map(roster => {
                      const shiftCfg = SHIFT_OPTIONS.find(s => s.value === roster.shiftCode);
                      return (
                        <tr key={roster.employeeId_date} className="hover:bg-slate-50 transition">
                          <td className="py-2.5 px-4 font-mono font-bold text-slate-900">{roster.employeeId}</td>
                          <td className="py-2.5 px-4 font-medium text-slate-800">{roster.fullName}</td>
                          <td className="py-2.5 px-4">
                            <span className="px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-[11px] font-semibold text-slate-700">
                              {roster.department}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-center font-mono text-[11px] text-slate-600">{roster.date}</td>
                          <td className="py-2.5 px-4 text-center">
                            <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${shiftCfg?.color || 'bg-slate-100 text-slate-700 border-slate-200'}`}>
                              {shiftCfg?.label || roster.shiftCode}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-center font-mono text-[11px] text-slate-600">
                            {roster.startTime} - {roster.endTime}
                          </td>
                          <td className="py-2.5 px-4 text-center font-mono text-[11px]">
                            {roster.restHours ? `${roster.restHours}h` : '—'}
                          </td>
                          <td className="py-2.5 px-4 text-center">
                            {roster.isRestViolation ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 font-bold text-[10px] border border-rose-200" title={roster.violationDetails}>
                                <AlertTriangle className="w-3 h-3" /> Vi phạm &lt; 12h
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-bold text-[10px] border border-emerald-200">
                                <CheckCheck className="w-3 h-3" /> Chuẩn &ge; 12h
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-4 text-center">
                            <span className="inline-flex items-center gap-1 text-emerald-700 font-bold text-[11px]">
                              <span className="w-2 h-2 rounded-full bg-emerald-500" />
                              Đã nạp Master DB
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Nhật ký các đợt nộp ca từ trạm gần nhất */}
          {shiftSubmissions.length > 0 && (
            <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-3">
              <h4 className="font-bold text-xs text-slate-800 flex items-center gap-2">
                <Clock className="w-4 h-4 text-indigo-600" />
                <span>Nhật Ký Các Đợt Nộp Ca Từ Máy Trạm Gần Nhất:</span>
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                {shiftSubmissions.slice(0, 3).map(sub => (
                  <div key={sub.id} className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl space-y-1">
                    <div className="flex justify-between items-center font-bold">
                      <span className="text-slate-900">{sub.department} ({sub.senderName})</span>
                      <span className="text-[10px] text-slate-500">{new Date(sub.submittedAt).toLocaleTimeString()}</span>
                    </div>
                    <div className="text-[11px] text-slate-600">
                      Quy mô: <b>{sub.employeeCount} NV</b> ({sub.rosterCount} ca gán)
                    </div>
                    {sub.violationCount > 0 ? (
                      <div className="text-[11px] text-rose-600 font-bold flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> {sub.violationCount} vi phạm xoay ca
                      </div>
                    ) : (
                      <div className="text-[11px] text-emerald-600 font-bold flex items-center gap-1">
                        <CheckCheck className="w-3 h-3" /> Không vi phạm thời gian nghỉ
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* ========================================================================= */
        /* VIEW MODE 2: CLIENT HOẶC HR THỰC HIỆN SẮP XẾP CA                          */
        /* ========================================================================= */
        <div className="space-y-6 flex-1 flex flex-col">
          {/* Toolbar */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-4">
            <div className="flex flex-col lg:flex-row gap-3 items-start lg:items-center justify-between">
              <div className="flex flex-wrap items-center gap-3 flex-1">
                {/* Search */}
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchManualTerm}
                    onChange={(e) => setSearchManualTerm(e.target.value)}
                    placeholder="Tìm tên, mã NV..."
                    className="pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs w-56 focus:outline-none focus:border-orange-500"
                  />
                </div>

                {/* Bộ phận */}
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-slate-500" />
                  <select
                    value={selectedDept}
                    onChange={(e) => setSelectedDept(e.target.value)}
                    disabled={!!departmentScope}
                    className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:border-orange-500 disabled:opacity-60"
                  >
                    {departmentScope ? (
                      <option value={departmentScope}>{departmentScope}</option>
                    ) : (
                      SHIFT_ELIGIBLE_DEPARTMENTS.map(d => (
                        <option key={d} value={d}>{d}</option>
                      ))
                    )}
                  </select>
                </div>

                {/* Chế độ ngày / tuần / tháng */}
                <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1">
                  {(['day', 'week', 'month'] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${mode === m ? 'bg-white shadow-xs text-slate-900 border border-slate-200' : 'text-slate-600 hover:text-slate-900'}`}
                    >
                      {m === 'day' ? 'Ngày' : m === 'week' ? 'Tuần' : 'Tháng'}
                    </button>
                  ))}
                </div>

                {/* Base date */}
                <div className="flex items-center gap-2">
                  <CalendarDays className="w-4 h-4 text-slate-500" />
                  <input
                    type="date"
                    value={baseDate}
                    onChange={(e) => setBaseDate(e.target.value)}
                    className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-orange-500"
                  />
                </div>
              </div>

              {/* Bulk actions */}
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={bulkShift}
                  onChange={(e) => setBulkShift(e.target.value as ShiftClassType)}
                  className="px-3 py-2 bg-white border border-slate-300 rounded-xl text-xs font-bold focus:outline-none focus:border-orange-500"
                >
                  {SHIFT_OPTIONS.map(s => (
                    <option key={s.value} value={s.value}>{s.label} ({s.time})</option>
                  ))}
                </select>
                <button
                  onClick={handleBulkApply}
                  disabled={!canManage || selectedEmployeeIds.size === 0}
                  className="px-3.5 py-2 bg-slate-900 hover:bg-black text-white rounded-xl text-xs font-bold disabled:opacity-40 flex items-center gap-1.5"
                >
                  <CheckSquare className="w-4 h-4" />
                  <span>Gán cho {selectedEmployeeIds.size || 'đã chọn'}</span>
                </button>
                <button
                  onClick={handleSaveAndSync}
                  disabled={!canManage || isSubmittingToHost}
                  className="px-4 py-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm disabled:opacity-40"
                >
                  {isSubmittingToHost ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  <span>Lưu & Gửi Lên Host Kiều ({mode === 'day' ? '1 ngày' : mode === 'week' ? '7 ngày' : 'cả tháng'})</span>
                </button>
              </div>
            </div>

            <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 flex items-center justify-between">
              <span>
                Đang sắp ca cho bộ phận <b>{departmentScope || selectedDept}</b> từ ngày <b>{baseDate}</b> ({getDateRange(mode, baseDate).length} ngày).
                Dữ liệu sẽ được truyền trực tiếp tới máy Host Kiều qua mạng P2P.
              </span>
              <span className="font-semibold text-indigo-700">
                Hiển thị {visibleEmployees.length} nhân viên • Đã chọn {selectedEmployeeIds.size}
              </span>
            </div>
          </div>

          {/* Table Sắp Ca */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex-1">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
                  <tr>
                    <th className="py-3 px-3 w-10">
                      <button onClick={toggleSelectAll} className="text-slate-600 hover:text-slate-900" title="Chọn tất cả">
                        {selectedEmployeeIds.size === visibleEmployees.length && visibleEmployees.length > 0 ? <CheckSquare className="w-4 h-4 text-orange-500" /> : <Square className="w-4 h-4" />}
                      </button>
                    </th>
                    <th className="py-3 px-3">Mã NV</th>
                    <th className="py-3 px-3">Họ Tên</th>
                    <th className="py-3 px-3">Bộ Phận</th>
                    <th className="py-3 px-3 text-center">Ca hiện tại ({baseDate})</th>
                    <th className="py-3 px-3 text-center">Chọn ca mới</th>
                    <th className="py-3 px-3 text-center">Trạng thái</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleEmployees.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-400 text-xs">
                        Không có nhân viên nào khớp bộ lọc{departmentScope ? ` (bộ phận ${departmentScope})` : ''}.
                      </td>
                    </tr>
                  ) : (
                    visibleEmployees.map(emp => {
                      const isSelected = selectedEmployeeIds.has(emp.employeeId);
                      const chosen = shiftSelections[emp.employeeId];
                      const current = currentShiftMap.get(emp.employeeId);
                      const displayCurrent = current ? SHIFT_OPTIONS.find(s => s.value === current)?.label + ` (${SHIFT_OPTIONS.find(s => s.value === current)?.time})` : '—';
                      return (
                        <tr key={emp.employeeId} className={`transition ${isSelected ? 'bg-orange-50/60' : 'hover:bg-slate-50/80'}`}>
                          <td className="py-2.5 px-3">
                            <button onClick={() => toggleSelectOne(emp.employeeId)} className="hover:text-orange-600">
                              {isSelected ? <CheckSquare className="w-4 h-4 text-orange-500" /> : <Square className="w-4 h-4 text-slate-400" />}
                            </button>
                          </td>
                          <td className="py-2.5 px-3 font-mono font-bold text-slate-900">{emp.employeeId}</td>
                          <td className="py-2.5 px-3 font-medium text-slate-800">{emp.fullName}</td>
                          <td className="py-2.5 px-3">
                            <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[11px] font-semibold border border-slate-200">{emp.department}</span>
                          </td>
                          <td className="py-2.5 px-3 text-center text-[11px] font-semibold text-slate-600">{displayCurrent}</td>
                          <td className="py-2.5 px-3 text-center">
                            <select
                              value={chosen || ''}
                              onChange={(e) => {
                                const v = e.target.value as ShiftClassType;
                                if (!v) {
                                  const next = { ...shiftSelections };
                                  delete next[emp.employeeId];
                                  setShiftSelections(next);
                                } else {
                                  setShiftSelections(prev => ({ ...prev, [emp.employeeId]: v }));
                                }
                              }}
                              className="px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-xs focus:outline-none focus:border-orange-500 min-w-[130px]"
                            >
                              <option value="">-- Chọn ca --</option>
                              {SHIFT_OPTIONS.map(s => (
                                <option key={s.value} value={s.value}>{s.label} | {s.time}</option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            {chosen ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[11px] font-bold border border-emerald-200">
                                <Users className="w-3 h-3" /> Đã chọn {SHIFT_OPTIONS.find(s => s.value === chosen)?.label}
                              </span>
                            ) : (
                              <span className="text-[11px] text-slate-400">Chưa chọn</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Footer Mobile/Quick actions */}
          <div className="flex items-center justify-between bg-white p-3 rounded-2xl border border-slate-200 shadow-sm">
            <div className="text-[11px] text-slate-500">
              Đã chọn <b>{selectedEmployeeIds.size}</b> / {visibleEmployees.length} NV • {getDateRange(mode, baseDate).length} ngày sẽ được tạo
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelectedEmployeeIds(new Set())}
                className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold"
              >
                Bỏ chọn
              </button>
              <button
                onClick={handleSaveAndSync}
                disabled={!canManage || isSubmittingToHost}
                className="px-4 py-1.5 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 disabled:opacity-40"
              >
                {isSubmittingToHost ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                <span>Lưu & Gửi Lên Host</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
