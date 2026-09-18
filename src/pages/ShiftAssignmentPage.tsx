import React, { useState, useMemo, useEffect } from 'react';
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
import { jsonSyncService, ScanResult, stampSyncMeta } from '../services/json-sync-service';

/**
 * Sắp Xếp Ca & Tiếp Nhận Ca qua JSON thuần (thay WebRTC Cluster):
 * - vinh/nguyetanh/han (Dept Admin): sắp ca phòng mình -> lưu local + ghi đè file dept riêng
 *   (dept_WH_vinh.json / dept_QC_nguyetanh.json / dept_PRD_han.json) trong HR_Data.
 * - kieu/hoa (Master): quét 3 file dept -> preview -> Tiếp nhận (merge LWW, audit đầy đủ).
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

  // Chế độ xem: kieu và hoa mặc định ở 'received' (tiếp nhận 3 file dept JSON)
  // vinh/nguyetanh/han mặc định ở 'manual' (sắp ca phòng mình -> ghi file dept riêng)
  const [viewMode, setViewMode] = useState<'received' | 'manual'>(isHostOrHR ? 'received' : 'manual');

  // Bộ lọc cho chế độ tiếp nhận (Host/HR review)
  const [selectedDeptReview, setSelectedDeptReview] = useState<string>('ALL');
  const [reviewViolationFilter, setReviewViolationFilter] = useState<'ALL' | 'REST_VIOLATION' | 'SHIFT_MISMATCH' | 'NORMAL'>('ALL');

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

  // Hộp thư file dept JSON chờ tiếp nhận (chỉ kieu/hoa)
  const [deptScan, setDeptScan] = useState<ScanResult | null>(null);
  const [isDeptScanning, setIsDeptScanning] = useState(false);
  const [ingestingDept, setIngestingDept] = useState<string | null>(null);

  useEffect(() => {
    if (!isHostOrHR) return;
    if (!jsonSyncService.folder.hasHandle() || !jsonSyncService.folder.isGranted()) return;
    let stop: (() => void) | undefined;
    stop = jsonSyncService.startAutoScan((r) => setDeptScan(r), 10000);
    return () => stop?.();
  }, [isHostOrHR]);

  const handleScanDept = async () => {
    setIsDeptScanning(true);
    try {
      setDeptScan(await jsonSyncService.scanFolder());
    } catch (err: any) {
      error('Quét thất bại', err?.message || 'Chưa kết nối HR_Data.');
    } finally {
      setIsDeptScanning(false);
    }
  };

  const handleIngestDept = async (file: string) => {
    if (!session) return;
    setIngestingDept(file);
    try {
      const res = await jsonSyncService.ingestDeptFile(file, { username: session.username, displayName: session.displayName });
      if (res.blocked.length > 0) warning('Có chặn NV', `${res.note}. Chặn ${res.blocked.length} dòng.`);
      else if (res.conflicts.length > 0) warning('Có conflict', `${res.note}. Conflict ${res.conflicts.length}.`);
      else success('Tiếp nhận xong', `${res.note}. Áp dụng ${res.applied}.`);
      setDeptScan(await jsonSyncService.scanFolder());
    } catch (err: any) {
      error('Tiếp nhận thất bại', err?.message || 'Không merge được.');
    } finally {
      setIngestingDept(null);
    }
  };

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
      const mismatches = deptRosters.filter(r => r.isShiftMismatch).length;
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
        mismatchesCount: mismatches,
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
      if (reviewViolationFilter === 'REST_VIOLATION' && !r.isRestViolation) return false;
      if (reviewViolationFilter === 'SHIFT_MISMATCH' && !r.isShiftMismatch) return false;
      if (reviewViolationFilter === 'NORMAL' && (r.isRestViolation || r.isShiftMismatch)) return false;
      return true;
    });
  }, [shiftRosters, selectedDeptReview, baseDate, searchReviewTerm, reviewViolationFilter]);

  // Thống kê tổng hợp KPI đối soát ngày được chọn
  const reviewSummary = useMemo(() => {
    const baseList = shiftRosters.filter(r => {
      if (selectedDeptReview !== 'ALL' && r.department !== selectedDeptReview) return false;
      if (baseDate && r.date !== baseDate) return false;
      return true;
    });
    const totalRosters = baseList.length;
    const violationCount = baseList.filter(r => r.isRestViolation).length;
    const mismatchCount = baseList.filter(r => r.isShiftMismatch).length;
    const matchedCount = baseList.filter(r => r.actualCheckIn && !r.isShiftMismatch).length;
    const accuracyRate = (matchedCount + mismatchCount) > 0 ? Math.round((matchedCount / (matchedCount + mismatchCount)) * 100) : 100;
    return { totalRosters, violationCount, mismatchCount, accuracyRate };
  }, [shiftRosters, selectedDeptReview, baseDate]);

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
    info('Đã áp dụng ca hàng loạt', `Đã gán ${bulkShift} cho ${selectedEmployeeIds.size} nhân viên đã chọn. Bấm "Lưu & Nộp File Dept" để đồng bộ.`);
  };

  // Lưu ca & ghi file dept JSON (dept admin) hoặc lưu master (kieu/hoa)
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
      const targetDept = departmentScope || selectedDept;
      const syncUser = (session?.username || '').toLowerCase();
      const syncName = session?.displayName || session?.username || 'unknown';
      const stampAt = new Date().toISOString();

      // Gắn _sync truy vết tác giả trước khi lưu (phục vụ merge kieu<->hoa LWW)
      const stamped = toSave.map((r: any) => stampSyncMeta({ ...r, department: r.department || targetDept }, syncUser || 'unknown', stampAt));

      // 1. Lưu vào Database cục bộ (Local-First)
      await db.transaction('rw', db.shiftRosters, db.employees, async () => {
        await db.shiftRosters.bulkPut(stamped as any);
        for (const [empId, shiftCode] of entries) {
          try {
            await db.employees.update(empId, { shiftClassId: shiftCode } as any);
          } catch { /* ignore */ }
        }
      });

      // 2. Dept Admin (vinh/nguyetanh/han): ghi đè file dept riêng trong HR_Data
      if (!isHostOrHR) {
        const res = await jsonSyncService.submitDeptShifts({
          username: syncUser,
          displayName: syncName,
          department: targetDept,
          rosters: stamped as any,
          entries,
          dateRange,
        });

        if (res.viaFolder && res.file) {
          success('Đã nộp file dept', `Đã ghi ${res.localCount} ca vào ${res.file} trong HR_Data. kieu/hoa sẽ quét và tiếp nhận.`);
        } else if (res.file) {
          info('Đã lưu cục bộ', `Đã lưu ${res.localCount} ca. Chưa kết nối HR_Data — bấm “Quét JSON” ở header để nộp file ${res.file}, hoặc tải tay trong Cài đặt.`);
        } else {
          info('Đã lưu cục bộ an toàn', `Đã lưu ${stamped.length} ca làm việc trên máy này.`);
        }
      } else {
        success(
          'Đã lưu ca (Master)',
          `Đã lưu ${stamped.length} ca (${entries.length} NV × ${dateRange.length} ngày). Nhớ “Xuất Master” trong Cài đặt > Đồng bộ JSON để máy kia merge.`
        );
      }

      if (session) {
        logUserAction({
          username: session.username,
          displayName: session.displayName,
          role: session.role,
          actionType: 'ASSIGN_SHIFT',
          targetEntity: `${targetDept} (${entries.length} NV, ${toSave.length} ca)`,
          details: `Sắp ca ${dateRange[0]} -> ${dateRange[dateRange.length - 1]} (file dept JSON, ${entries.length} NV)`
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
                <span>{isHostOrHR && viewMode === 'received' ? 'Tiếp Nhận File Dept JSON (3 Phòng)' : 'Sắp Xếp Ca Làm Việc'}</span>
                {isHostOrHR && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                    kieu & Hoa — Master
                  </span>
                )}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {isHostOrHR && viewMode === 'received'
                  ? 'Quét và tiếp nhận 3 file dept riêng: dept_WH_vinh.json, dept_QC_nguyetanh.json, dept_PRD_han.json trong HR_Data.'
                  : 'Sắp ca cho nhân viên phòng bạn. Bấm Lưu để ghi vào file dept riêng, kieu/hoa sẽ quét và tiếp nhận.'}
              </p>
            </div>
          </div>
        </div>

        {/* Nút chuyển chế độ của kieu / hoa */}
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
          {/* Hộp thư 3 file dept JSON chờ tiếp nhận */}
          <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-sm space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Inbox className="w-4 h-4 text-emerald-600" />
                <span>File dept JSON chờ tiếp nhận (HR_Data)</span>
                {deptScan && (deptScan.pendingDept.length > 0) && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-rose-100 text-rose-700 border border-rose-200">{deptScan.pendingDept.length} mới</span>
                )}
              </h3>
              <button onClick={handleScanDept} disabled={isDeptScanning} className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-bold rounded-xl transition disabled:opacity-50 flex items-center gap-1.5">
                <RefreshCw className={`w-3.5 h-3.5 ${isDeptScanning ? 'animate-spin' : ''}`} />
                <span>{isDeptScanning ? 'Đang quét...' : 'Quét HR_Data'}</span>
              </button>
            </div>
            {!jsonSyncService.folder.hasHandle() || !jsonSyncService.folder.isGranted() ? (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                Chưa kết nối thư mục HR_Data — bấm “Quét JSON” trên thanh header (1 click) để cấp quyền, sau đó quét lại.
              </p>
            ) : !deptScan ? (
              <p className="text-[11px] text-slate-500">Bấm “Quét HR_Data” để liệt kê dept_WH_vinh / dept_QC_nguyetanh / dept_PRD_han mới.</p>
            ) : deptScan.pendingDept.length === 0 ? (
              <p className="text-[11px] text-emerald-700 font-semibold flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Không có file dept mới.</p>
            ) : (
              <div className="space-y-2">
                {deptScan.pendingDept.map((it) => (
                  <div key={it.file} className="flex items-center justify-between gap-2 p-2.5 border border-slate-200 rounded-xl text-xs">
                    <div><div className="font-mono font-bold">{it.file}</div><div className="text-slate-500 text-[11px]">{it.note}</div></div>
                    <button disabled={ingestingDept === it.file} onClick={() => handleIngestDept(it.file)} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold rounded-xl transition shrink-0 disabled:opacity-50">
                      {ingestingDept === it.file ? 'Đang nhận...' : 'Tiếp Nhận'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* 4 Thẻ KPI Tổng Hợp Đối Soát Tiếp Nhận Ca & Chấm Công */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-3.5 bg-white rounded-2xl border border-slate-200 shadow-xs flex items-center gap-3">
              <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-xl shrink-0">
                <Briefcase className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[11px] font-semibold text-slate-500">Tổng ca tiếp nhận ({baseDate})</p>
                <p className="text-lg font-black text-slate-900">{reviewSummary.totalRosters} <span className="text-xs font-normal text-slate-500">ca</span></p>
              </div>
            </div>

            <div className="p-3.5 bg-white rounded-2xl border border-slate-200 shadow-xs flex items-center gap-3">
              <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-xl shrink-0">
                <CheckCheck className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[11px] font-semibold text-slate-500">Tỷ lệ đúng ca đã sắp</p>
                <p className="text-lg font-black text-emerald-600">{reviewSummary.accuracyRate}%</p>
              </div>
            </div>

            <div className="p-3.5 bg-white rounded-2xl border border-slate-200 shadow-xs flex items-center gap-3">
              <div className="p-2.5 bg-amber-50 text-amber-600 rounded-xl shrink-0">
                <Clock className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[11px] font-semibold text-slate-500">Đi sai giờ sắp ca</p>
                <p className={`text-lg font-black ${reviewSummary.mismatchCount > 0 ? 'text-amber-600' : 'text-slate-900'}`}>
                  {reviewSummary.mismatchCount} <span className="text-xs font-normal text-slate-500">lệch</span>
                </p>
              </div>
            </div>

            <div className="p-3.5 bg-white rounded-2xl border border-slate-200 shadow-xs flex items-center gap-3">
              <div className="p-2.5 bg-rose-50 text-rose-600 rounded-xl shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <p className="text-[11px] font-semibold text-slate-500">Vi phạm nghỉ &lt; 12h</p>
                <p className={`text-lg font-black ${reviewSummary.violationCount > 0 ? 'text-rose-600' : 'text-slate-900'}`}>
                  {reviewSummary.violationCount} <span className="text-xs font-normal text-slate-500">vi phạm</span>
                </p>
              </div>
            </div>
          </div>

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
                <div className="pt-1 flex justify-between items-center text-[11px]">
                  <span className="text-slate-500">Đi sai giờ sắp ca:</span>
                  {deptStats.wh.mismatchesCount > 0 ? (
                    <span className="font-bold text-amber-600 flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" /> {deptStats.wh.mismatchesCount} cảnh báo
                    </span>
                  ) : (
                    <span className="font-bold text-emerald-600 flex items-center gap-1">
                      <CheckCheck className="w-3.5 h-3.5" /> 0 lệch (Chuẩn)
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
                <div className="pt-1 flex justify-between items-center text-[11px]">
                  <span className="text-slate-500">Đi sai giờ sắp ca:</span>
                  {deptStats.qc.mismatchesCount > 0 ? (
                    <span className="font-bold text-amber-600 flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" /> {deptStats.qc.mismatchesCount} cảnh báo
                    </span>
                  ) : (
                    <span className="font-bold text-emerald-600 flex items-center gap-1">
                      <CheckCheck className="w-3.5 h-3.5" /> 0 lệch (Chuẩn)
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
                <div className="pt-1 flex justify-between items-center text-[11px]">
                  <span className="text-slate-500">Đi sai giờ sắp ca:</span>
                  {deptStats.prd.mismatchesCount > 0 ? (
                    <span className="font-bold text-amber-600 flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" /> {deptStats.prd.mismatchesCount} cảnh báo
                    </span>
                  ) : (
                    <span className="font-bold text-emerald-600 flex items-center gap-1">
                      <CheckCheck className="w-3.5 h-3.5" /> 0 lệch (Chuẩn)
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

              {/* Lọc trạng thái cảnh báo / vi phạm */}
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl text-xs font-bold">
                <button
                  onClick={() => setReviewViolationFilter('ALL')}
                  className={`px-2.5 py-1.5 rounded-lg transition ${reviewViolationFilter === 'ALL' ? 'bg-white shadow-xs text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  Tất cả ({reviewSummary.totalRosters})
                </button>
                <button
                  onClick={() => setReviewViolationFilter('REST_VIOLATION')}
                  className={`px-2.5 py-1.5 rounded-lg transition ${reviewViolationFilter === 'REST_VIOLATION' ? 'bg-white shadow-xs text-rose-700 font-extrabold' : 'text-slate-500 hover:text-rose-600'}`}
                >
                  Nghỉ &lt; 12h ({reviewSummary.violationCount})
                </button>
                <button
                  onClick={() => setReviewViolationFilter('SHIFT_MISMATCH')}
                  className={`px-2.5 py-1.5 rounded-lg transition ${reviewViolationFilter === 'SHIFT_MISMATCH' ? 'bg-white shadow-xs text-amber-700 font-extrabold' : 'text-slate-500 hover:text-amber-600'}`}
                >
                  Đi sai ca ({reviewSummary.mismatchCount})
                </button>
                <button
                  onClick={() => setReviewViolationFilter('NORMAL')}
                  className={`px-2.5 py-1.5 rounded-lg transition ${reviewViolationFilter === 'NORMAL' ? 'bg-white shadow-xs text-emerald-700' : 'text-slate-500 hover:text-emerald-600'}`}
                >
                  Đúng chuẩn
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
                    <th className="py-3 px-4 text-center">Ca Được Sắp</th>
                    <th className="py-3 px-4 text-center">Chấm Công Thực Tế</th>
                    <th className="py-3 px-4 text-center">Nghỉ Giữa 2 Ca</th>
                    <th className="py-3 px-4 text-center">Đối Soát Cảnh Báo</th>
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
                      const actualShiftCfg = SHIFT_OPTIONS.find(s => s.value === roster.actualShiftCode);
                      return (
                        <tr
                          key={roster.employeeId_date}
                          className={`hover:bg-slate-50 transition ${
                            roster.isRestViolation
                              ? 'bg-rose-50/25'
                              : roster.isShiftMismatch
                              ? 'bg-amber-50/25'
                              : ''
                          }`}
                        >
                          <td className="py-2.5 px-4 font-mono font-bold text-slate-900">{roster.employeeId}</td>
                          <td className="py-2.5 px-4 font-medium text-slate-800">{roster.fullName}</td>
                          <td className="py-2.5 px-4">
                            <span className="px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-[11px] font-semibold text-slate-700">
                              {roster.department}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-center font-mono text-[11px] text-slate-600">{roster.date}</td>
                          <td className="py-2.5 px-4 text-center">
                            <div className="inline-flex flex-col items-center">
                              <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold border ${shiftCfg?.color || 'bg-slate-100 text-slate-700 border-slate-200'}`}>
                                {shiftCfg?.label || roster.shiftCode}
                              </span>
                              <span className="text-[10px] text-slate-400 font-mono mt-0.5">{roster.startTime} - {roster.endTime}</span>
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-center">
                            {roster.actualCheckIn ? (
                              <div className="inline-flex flex-col items-center">
                                <span className="font-mono text-slate-800 font-bold text-[11px]">
                                  {roster.actualCheckIn} - {roster.actualCheckOut || '...'}
                                </span>
                                {roster.actualShiftCode && (
                                  <span className={`px-1.5 py-0.2 rounded text-[10px] font-semibold mt-0.5 ${actualShiftCfg?.color || 'bg-slate-100 text-slate-600'}`}>
                                    {actualShiftCfg?.label || roster.actualShiftCode}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-400 italic text-[11px]">Chưa có quẹt thẻ</span>
                            )}
                          </td>
                          <td className="py-2.5 px-4 text-center font-mono text-[11px]">
                            {roster.restHours ? (
                              <span className={`font-bold ${roster.isRestViolation ? 'text-rose-600' : 'text-slate-700'}`}>
                                {roster.restHours}h
                              </span>
                            ) : '—'}
                          </td>
                          <td className="py-2.5 px-4 text-center">
                            <div className="flex flex-col items-center gap-1">
                              {roster.isRestViolation && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 font-bold text-[10px] border border-rose-200" title={roster.violationDetails}>
                                  <AlertTriangle className="w-3 h-3" /> Vi phạm &lt; 12h
                                </span>
                              )}
                              {roster.isShiftMismatch && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold text-[10px] border border-amber-200" title={roster.mismatchDetails}>
                                  <Clock className="w-3 h-3 text-amber-600" /> Đi sai giờ sắp ca
                                </span>
                              )}
                              {!roster.isRestViolation && !roster.isShiftMismatch && roster.actualCheckIn && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-bold text-[10px] border border-emerald-200">
                                  <CheckCheck className="w-3 h-3" /> Đúng ca & chuẩn nghỉ
                                </span>
                              )}
                              {!roster.isRestViolation && !roster.isShiftMismatch && !roster.actualCheckIn && (
                                <span className="text-slate-400 text-[10px]">Chờ chấm công</span>
                              )}
                            </div>
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
                  <span>Lưu & Nộp File Dept ({mode === 'day' ? '1 ngày' : mode === 'week' ? '7 ngày' : 'cả tháng'})</span>
                </button>
              </div>
            </div>

            <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 flex items-center justify-between">
              <span>
                Đang sắp ca cho bộ phận <b>{departmentScope || selectedDept}</b> từ ngày <b>{baseDate}</b> ({getDateRange(mode, baseDate).length} ngày).
                Bấm Lưu để ghi vào file dept riêng trong HR_Data (kieu/hoa quét và tiếp nhận).
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
