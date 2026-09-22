import React, { useState, useMemo, useEffect } from 'react';
import { 
  CalendarDays, 
  Search, 
  FileSpreadsheet, 
  CalendarRange, 
  Building2, 
  Clock3, 
  AlertTriangle,
  Trash2
} from 'lucide-react';
import { useLiveTable, upsertOne, clearTable } from '../lib/tables';
import type { IEmployee, IDailyTimesheetCell, IOvertimeRecord, ILeaveRequest, IProductivityQualityRate, AttendanceStatusCode } from '../types';
import { computeEmployeeTimesheetSummary } from '../services/formula-engine';
import { generateCalendarDays, CalendarDay } from '../services/calendar-utils';
import { formatPayPeriodLabel } from '../services/pay-period';
import { getDayParts, formatHours } from '../services/day-hours';
import { OvertimeEditModal } from '../components/overtime/OvertimeEditModal';
import type { NavPageId } from '../components/layout/Sidebar';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';
import { useAuth } from '../context/AuthContext';
import { exportTimesheetToExcel } from '../services/excel-exporter';

interface TimesheetCalendarPageProps {
  onNavigate?: (page: NavPageId) => void;
}

/** 3 cụm hiển thị (user chốt): HC23 = OFFICE_M_F · HC_CA = chính thức còn lại · SEASONAL = mọi thời vụ */
export type TimesheetCluster = 'HC23' | 'HC_CA' | 'SEASONAL';

export function clusterOf(emp: IEmployee): TimesheetCluster {
  if (emp.contractType === 'SEASONAL') return 'SEASONAL';
  if (emp.shiftClassId === 'OFFICE_M_F') return 'HC23';
  return 'HC_CA';
}

export const CLUSTER_META: Record<TimesheetCluster, { label: string; cycle: 'OFFICIAL' | 'SEASONAL' }> = {
  HC23: { label: 'Hành chính 23 công (T2-T6)', cycle: 'OFFICIAL' },
  HC_CA: { label: 'HC + Ca 1 + Ca 2', cycle: 'OFFICIAL' },
  SEASONAL: { label: 'Thời vụ 1-31', cycle: 'SEASONAL' },
};

export const TimesheetCalendarPage: React.FC<TimesheetCalendarPageProps> = ({ onNavigate }) => {
  const { success, warning } = useToast();
  const { confirm } = useModal();
  const { departmentScope, hasPermission, systemSettings } = useAuth();
  // Mặc định vào là cụm hành chính 23 công; tab khác chỉ render khi chuyển sang
  const [cluster, setCluster] = useState<TimesheetCluster>('HC23');

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDept, setSelectedDept] = useState<string>('ALL');
  // Kỳ lương đang xem (VD 21/9-20/10 = lương tháng 10/2026); tự set khi nạp file mới
  const [payMonth, setPayMonth] = useState<number>(() => {
    const saved = localStorage.getItem('smarthr_selected_month');
    return saved ? parseInt(saved, 10) : 8;
  });
  const [payYear, setPayYear] = useState<number>(() => {
    const saved = localStorage.getItem('smarthr_selected_year');
    return saved ? parseInt(saved, 10) : 2026;
  });

  // Tự động đồng bộ kỳ lương khi nạp file chấm công mới
  useEffect(() => {
    const handler = (e: any) => {
      if (e.detail?.month) setPayMonth(e.detail.month);
      if (e.detail?.year) setPayYear(e.detail.year);
    };
    window.addEventListener('timesheet:period_changed', handler);
    return () => window.removeEventListener('timesheet:period_changed', handler);
  }, []);

  const shiftPayPeriod = (delta: number) => {
    let m = payMonth + delta;
    let y = payYear;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    setPayMonth(m);
    setPayYear(y);
    try {
      localStorage.setItem('smarthr_selected_month', String(m));
      localStorage.setItem('smarthr_selected_year', String(y));
    } catch {}
  };

  const [activeEditCell, setActiveEditCell] = useState<{
    employee: IEmployee;
    cell: IDailyTimesheetCell;
    dateLabel: string;
  } | null>(null);

  const employees = useLiveTable<IEmployee>('employees');
  const timesheets = useLiveTable<IDailyTimesheetCell>('dailyTimesheets');
  const overtimes = useLiveTable<IOvertimeRecord>('overtimeRecords');
  const leaveRequests = useLiveTable<ILeaveRequest>('leaveRequests');
  const rates = useLiveTable<IProductivityQualityRate>('productivityQualityRates');

  const canManageOt = hasPermission('MANAGE_OT') || hasPermission('PROPOSE_DEPT_OT');

  // Modal tăng ca dùng chung với OvertimePage (mở từ cột OT của bảng công)
  const [activeOtRecord, setActiveOtRecord] = useState<{
    employee: IEmployee;
    day: CalendarDay;
    otRecord: IOvertimeRecord;
  } | null>(null);

  const handleClearTimesheetData = async () => {
    if (!hasPermission('MANAGE_TIMESHEET')) {
      warning?.('Không đủ quyền', 'Bạn không có quyền làm sạch dữ liệu bảng chấm công.');
      return;
    }
    const ok = await confirm({
      title: 'Xác nhận làm sạch dữ liệu Bảng chấm công',
      message: 'Thao tác này chỉ xóa sạch dữ liệu quẹt thẻ và tính công trên Bảng chấm công để sẵn sàng import dữ liệu nguồn mới. Toàn bộ danh mục nhân viên, hợp đồng, phụ cấp và cấu hình hoàn toàn được bảo lưu 100%.',
      confirmText: 'Làm sạch ngay',
      cancelText: 'Hủy bỏ',
      type: 'danger'
    });
    if (ok) {
      await clearTable('dailyTimesheets');
      await clearTable('rawAttendanceLogs');
      await clearTable('overtimeRecords');
      await clearTable('leaveRequests');
      await clearTable('shiftRosters');
      success('Đã làm sạch bảng chấm công', 'Toàn bộ dữ liệu bảng công, tăng ca, danh sách chờ bù phép và vi phạm ca đã được xóa sạch. Sẵn sàng nạp file nguồn mới.');
    }
  };

  const clusterCounts = useMemo(() => {
    const counts: Record<TimesheetCluster, number> = { HC23: 0, HC_CA: 0, SEASONAL: 0 };
    employees.forEach(emp => {
      if (departmentScope && emp.department !== departmentScope) return;
      counts[clusterOf(emp)]++;
    });
    return counts;
  }, [employees, departmentScope]);

  // Chỉ render cụm đang mở (tab khác không tính/lọc)
  const filteredEmployees = useMemo(() => {
    return employees.filter(emp => {
      if (clusterOf(emp) !== cluster) return false;
      if (departmentScope && emp.department !== departmentScope) return false;
      if (selectedDept !== 'ALL' && emp.department !== selectedDept) return false;
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        const m1 = emp.employeeId.toLowerCase().includes(q);
        const m2 = emp.fullName.toLowerCase().includes(q);
        if (!m1 && !m2) return false;
      }
      return true;
    });
  }, [employees, departmentScope, selectedDept, cluster, searchTerm]);

  const departments = Array.from(new Set(employees.map(e => e.department))).filter(Boolean);

  const timesheetMap = useMemo(() => {
    const map = new Map<string, IDailyTimesheetCell>();
    timesheets.forEach(ts => map.set(ts.employeeId_date, ts));
    return map;
  }, [timesheets]);

  const overtimeMap = useMemo(() => {
    const map = new Map<string, IOvertimeRecord>();
    overtimes.forEach(ot => map.set(ot.employeeId_date, ot));
    return map;
  }, [overtimes]);

  const leaveMap = useMemo(() => {
    const map = new Map<string, ILeaveRequest>();
    leaveRequests.forEach(r => map.set(`${r.employeeId}_${r.date}`, r));
    return map;
  }, [leaveRequests]);

  const activeCycle = CLUSTER_META[cluster].cycle;
  const payLabel = formatPayPeriodLabel(payMonth, payYear, activeCycle);

  const calendarDays = useMemo(() => generateCalendarDays(payMonth, payYear, activeCycle), [payMonth, payYear, activeCycle]);

  // Tính tỷ lệ trung bình % NS và % CL của từng chuyền sản xuất trong kỳ đang xem
  const lineAverageRatesMap = useMemo(() => {
    const stats = new Map<string, { sumNS: number; countNS: number; sumCL: number; countCL: number }>();
    const activeDates = new Set(calendarDays.map(d => d.dateStr));

    rates.forEach(r => {
      if (activeDates.has(r.date)) {
        let entry = stats.get(r.lineId);
        if (!entry) {
          entry = { sumNS: 0, countNS: 0, sumCL: 0, countCL: 0 };
          stats.set(r.lineId, entry);
        }
        if (r.productivityRate != null) { entry.sumNS += r.productivityRate; entry.countNS++; }
        if (r.qualityRate != null) { entry.sumCL += r.qualityRate; entry.countCL++; }
      }
    });

    const result = new Map<string, { avgNS: number; avgCL: number }>();
    stats.forEach((v, k) => {
      result.set(k, {
        avgNS: v.countNS > 0 ? Math.round(v.sumNS / v.countNS) : 100,
        avgCL: v.countCL > 0 ? Math.round(v.sumCL / v.countCL) : 98
      });
    });
    return result;
  }, [rates, calendarDays]);

  const handleCellClick = (emp: IEmployee, day: CalendarDay) => {
    if (!hasPermission('MANAGE_TIMESHEET')) {
      warning?.('Không đủ quyền', 'Bạn không có quyền chỉnh sửa bảng chấm công (MANAGE_TIMESHEET).');
      return;
    }
    const key = `${emp.employeeId}_${day.dateStr}`;
    const cell = timesheetMap.get(key) || {
      employeeId_date: key,
      employeeId: emp.employeeId,
      date: day.dateStr,
      dayIndex: day.dayIndex,
      statusCode: '',
      calculatedOvertime: 0,
      month: day.monthNum,
      year: day.yearNum
    } as IDailyTimesheetCell;

    setActiveEditCell({
      employee: emp,
      cell: { ...cell },
      dateLabel: `${day.dayVi}, ${day.dayNum}/${day.monthNum}/${day.yearNum}`
    });
  };

  const handleSaveCell = async (newCode: AttendanceStatusCode) => {
    if (!activeEditCell) return;
    const isVio = ['LA', 'ED', 'MCO', 'MCI', 'Off', 'OFF'].includes(newCode);
    const updated: IDailyTimesheetCell = {
      ...activeEditCell.cell,
      statusCode: newCode,
      isViolation: isVio,
      isViolationFlag: (isVio ? 1 : 0) as (0 | 1),
      violationNote: isVio
        ? (activeEditCell.cell.violationNote || `Điều chỉnh thủ công sang mã vi phạm ${newCode}`)
        : undefined
    };
    await upsertOne('dailyTimesheets', updated);
    success('Đã cập nhật công', `Nhân viên ${activeEditCell.employee.fullName} ngày ${activeEditCell.dateLabel} đã được chuyển sang mã "${newCode}".`);
    setActiveEditCell(null);
  };

  const handleExport = async () => {
    await exportTimesheetToExcel(filteredEmployees, timesheets, overtimes, payMonth, payYear, activeCycle, systemSettings, leaveRequests);
    const label = activeCycle === 'OFFICIAL' ? `Chính thức ${payLabel}` : `Thời vụ ${payLabel}`;
    success(`Xuất file chốt công thành công!`, `Đã xuất ${filteredEmployees.length} nhân viên — ${label}`);
  };

  // Mở modal tăng ca (dùng chung OvertimeEditModal) từ cột OT của bảng công
  const handleOpenOtCell = (emp: IEmployee, day: CalendarDay) => {
    if (!canManageOt) {
      warning?.('Không đủ quyền', 'Bạn không có quyền quản lý tăng ca (MANAGE_OT hoặc PROPOSE_DEPT_OT).');
      return;
    }
    const key = `${emp.employeeId}_${day.dateStr}`;
    const existing = overtimeMap.get(key);
    if (existing) {
      setActiveOtRecord({ employee: emp, day, otRecord: existing });
    } else {
      setActiveOtRecord({
        employee: emp,
        day,
        otRecord: {
          employeeId_date: key,
          employeeId: emp.employeeId,
          date: day.dateStr,
          dayOfWeek: day.dayVi,
          dayType: day.isSunday ? 'SUNDAY' : 'WEEKDAY',
          hours: 0,
          month: day.monthNum,
          year: day.yearNum,
          rawMinutes: 0,
          verificationStatus: 'PENDING'
        },
      });
    }
  };

  const renderTable = (emps: IEmployee[], days: CalendarDay[], title?: string) => {
    if (emps.length === 0) return (
      <div className="p-8 text-center text-xs text-slate-500 bg-slate-50/50 border-t">Không có nhân viên thuộc nhóm này</div>
    );
    return (
      <div className="overflow-x-auto overflow-y-auto max-h-[62vh] flex-1">
        <table className="w-full text-left text-xs border-collapse">
          <thead className="bg-slate-900 text-white font-bold sticky top-0 z-30 shadow-md">
            <tr>
              <th rowSpan={2} className="py-2.5 px-2 bg-slate-900 sticky left-0 z-40 w-10 text-center border-r border-slate-800 align-middle">#</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-slate-900 sticky left-10 z-40 w-20 border-r border-slate-800 align-middle">Mã NV</th>
              <th rowSpan={2} className="py-2.5 px-3 bg-slate-900 sticky left-[112px] z-40 min-w-[158px] max-w-[170px] border-r border-slate-800 align-middle">Họ và Tên <span className="font-normal opacity-60 text-[10px]">(+Bộ phận)</span></th>
              {days.map((day) => (
                <th key={day.dayIndex} colSpan={3} className={`py-1.5 px-1 text-center border-r border-slate-800 select-none ${day.isSunday ? 'bg-amber-950/80 text-amber-200' : (day.isSaturday ? 'bg-slate-800 text-slate-300' : 'bg-slate-900')}`}>
                  <div className="text-[10px] opacity-75">{day.dayVi}</div>
                  <div className="text-xs font-bold">{day.dayNum}</div>
                </th>
              ))}
              <th rowSpan={2} className="py-2.5 px-2 bg-indigo-950 text-indigo-200 text-center min-w-[72px] border-r border-indigo-900 whitespace-nowrap align-middle">Công Chuẩn</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-emerald-950 text-emerald-200 text-center min-w-[76px] border-r border-emerald-900 whitespace-nowrap align-middle">Công Thực Tế</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-blue-950 text-blue-200 text-center min-w-[55px] border-r border-blue-900 whitespace-nowrap align-middle" title="Phép năm">AL</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-rose-950 text-rose-200 text-center min-w-[55px] border-r border-rose-900 whitespace-nowrap align-middle" title="Nghỉ không phép / HR từ chối">Off</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-slate-800 text-slate-200 text-center min-w-[55px] border-r border-slate-700 whitespace-nowrap align-middle" title="Nghỉ có phép không lương">UL</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-purple-950 text-purple-200 text-center min-w-[55px] border-r border-purple-900 whitespace-nowrap align-middle" title="Nghỉ thai sản">ML</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-sky-950 text-sky-200 text-center min-w-[55px] border-r border-sky-900 whitespace-nowrap align-middle" title="Đi công tác">BT</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-pink-950 text-pink-200 text-center min-w-[55px] border-r border-pink-900 whitespace-nowrap align-middle" title="Nghỉ ốm">SL</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-amber-950 text-amber-200 text-center min-w-[55px] border-r border-amber-900 whitespace-nowrap align-middle" title="Nghỉ lễ">PH</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-teal-950 text-teal-200 text-center min-w-[55px] border-r border-teal-900 whitespace-nowrap align-middle" title="Phép chế độ">PL</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-indigo-950 text-indigo-200 text-center min-w-[68px] border-r border-indigo-900 whitespace-nowrap align-middle">Ca Đêm N</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-slate-900 text-slate-200 text-center min-w-[72px] border-r border-slate-800 whitespace-nowrap align-middle">Trễ/Sớm</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-emerald-950 text-emerald-200 text-center min-w-[96px] border-r border-emerald-900 whitespace-nowrap align-middle">Năng suất</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-orange-950 text-orange-200 text-center min-w-[92px] border-r border-orange-900 whitespace-nowrap align-middle">Chuyên cần</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-emerald-900 text-emerald-100 text-center min-w-[85px] border-r border-emerald-800 whitespace-nowrap align-middle">Thưởng thêm</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-red-950 text-red-200 text-center min-w-[78px] border-r border-red-900 whitespace-nowrap align-middle">Độc hại</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-amber-950 text-amber-200 text-center min-w-[78px] border-r border-amber-900 whitespace-nowrap align-middle">PCCC</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-slate-800 text-slate-200 text-center min-w-[84px] border-r border-slate-700 whitespace-nowrap align-middle">Chi phí khác</th>
              <th rowSpan={2} className="py-2.5 px-2 bg-slate-900 text-slate-200 text-center min-w-[78px] whitespace-nowrap align-middle">Đoàn phí</th>
            </tr>
            <tr>
              {days.flatMap((day) => (['Giờ', 'Phép', 'TC'] as const).map((sub, i) => (
                <th
                  key={`${day.dayIndex}-${sub}`}
                  title={i === 0 ? 'Giờ làm thực tế (đủ 8 xanh, 6-7.9 cam, <6 đỏ nhấp nháy)' : i === 1 ? 'Giờ phép còn thiếu (Off chờ duyệt, AL/UL/... đã duyệt)' : 'Giờ tăng ca (logic Overtime Table, bấm để xem/sửa)'}
                  className={`py-1 px-0.5 text-center text-[9px] font-bold min-w-[34px] ${i < 2 ? 'border-r border-slate-700/60' : 'border-r border-slate-800'} ${day.isSunday ? 'bg-amber-950/80 text-amber-200' : (day.isSaturday ? 'bg-slate-800 text-slate-300' : 'bg-slate-900 text-slate-300')}`}
                >
                  {sub}
                </th>
              )))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            {emps.map((emp, empIdx) => {
              const effectiveDays = days;
              const empCells: IDailyTimesheetCell[] = [];
              effectiveDays.forEach(d => {
                const c = timesheetMap.get(`${emp.employeeId}_${d.dateStr}`);
                if (c) empCells.push(c);
              });
              const deptRule = systemSettings.diligenceDeductionRules.find(r => r.department === emp.department) || systemSettings.diligenceDeductionRules.find(r => r.department === 'ALL') || systemSettings.diligenceDeductionRules[0];
              const prodBase = systemSettings.productivityBonusConfig?.useDepartmentOverride && systemSettings.productivityBonusConfig.departmentBaseRates?.[emp.department] != null
                ? systemSettings.productivityBonusConfig.departmentBaseRates[emp.department]!
                : (emp.customAllowances?.productivityBonus || systemSettings.productivityBonusConfig?.defaultBaseRate || 1000000);
              const diligenceBase = systemSettings.diligenceBonusConfig?.baseAmount ?? 500000;
              const lineRates = emp.productionLine ? lineAverageRatesMap.get(emp.productionLine) : undefined;
              const summary = computeEmployeeTimesheetSummary(emp, empCells, {
                diligenceRules: deptRule ? { twoDaysULPenaltyPct: deptRule.twoDaysULPenaltyPct, threeDaysULPenaltyPct: deptRule.threeDaysULPenaltyPct } : undefined,
                diligenceBaseAmount: emp.customAllowances?.diligenceBonus || diligenceBase,
                countOffAsUL: systemSettings.diligenceBonusConfig?.countOffAsUL ?? true,
                productivityBaseRate: prodBase,
                productivityConfig: systemSettings.productivityBonusConfig,
                lineProductivityRate: lineRates?.avgNS,
                lineQualityRate: lineRates?.avgCL,
                tradeUnionFee: systemSettings.tradeUnionFee ?? 40000,
                extraBonus: emp.customAllowances?.extraBonus ?? 0
              });

              return (
                <tr key={emp.employeeId} className="hover:bg-orange-50/30 transition group">
                  <td className="py-2 px-2 bg-white group-hover:bg-orange-50/50 sticky left-0 z-20 text-center font-semibold text-slate-400 border-r border-slate-200">{empIdx + 1}</td>
                  <td className="py-2 px-2 bg-white group-hover:bg-orange-50/50 sticky left-10 z-20 font-bold text-slate-900 border-r border-slate-200"><span className="px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-800 font-mono text-[11px]">{emp.employeeId}</span></td>
                  <td className="py-2 px-2 bg-white group-hover:bg-orange-50/50 sticky left-[112px] z-20 border-r border-slate-200 min-w-[158px] max-w-[170px]">
                    <div className="font-bold text-slate-800 text-xs leading-tight truncate" title={emp.fullName}>{emp.fullName}</div>
                    <div className="text-[11px] font-semibold text-slate-500 truncate flex items-center gap-1" title={emp.department}><span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0"></span>{emp.department}</div>
                    <div className="text-[10px] text-slate-400 truncate">{emp.contractType === 'OFFICIAL' ? 'Chính thức 21-20' : 'Thời vụ 1-31'} • {emp.shiftClassId}</div>
                  </td>
                  {effectiveDays.map((day) => {
                    const key = `${emp.employeeId}_${day.dateStr}`;
                    const cell = timesheetMap.get(key);
                    const otRec = overtimeMap.get(key) ?? null;
                    const leaveReq = leaveMap.get(key);
                    const parts = getDayParts(emp, cell, otRec, leaveReq, day.isSunday);
                    const punchTitle = cell?.checkIn || cell?.checkOut
                      ? `Quẹt: ${cell?.checkIn || '--:--'} → ${cell?.checkOut || '--:--'}${cell?.violationNote ? ` | ${cell.violationNote}` : ''}`
                      : (cell?.violationNote || `${emp.employeeId} • ${day.dateStr}`);

                    // --- Cột 1: giờ làm (đủ 8 xanh · 6-7.9 cam · <6 đỏ nhấp nháy) ---
                    let workBadge = <span className="text-slate-300 text-[11px]">-</span>;
                    if (parts.worked !== null) {
                      const label = formatHours(parts.worked);
                      if (parts.isFullLegalLeave) {
                        workBadge = <span className="w-6 h-6 rounded-md bg-slate-100 text-slate-500 font-bold flex items-center justify-center text-[11px] border border-slate-200" title={`Nghỉ cả ngày (${parts.leave?.text})`}>0</span>;
                      } else if (parts.workedTone === 'full') {
                        workBadge = <span className="w-6 h-6 rounded-md bg-emerald-100 text-emerald-800 font-bold flex items-center justify-center text-[11px] shadow-sm" title={`${label}h — đủ công. ${punchTitle}`}>{label}</span>;
                      } else if (parts.workedTone === 'warn') {
                        workBadge = <span className="w-6 h-6 rounded-md bg-orange-100 text-orange-800 font-bold flex items-center justify-center text-[11px] border border-orange-300 shadow-sm" title={`${label}h — thiếu giờ. ${punchTitle}`}>{label}</span>;
                      } else {
                        workBadge = <span className="w-6 h-6 rounded-md bg-rose-100 text-rose-800 font-bold flex items-center justify-center text-[11px] border border-rose-300 shadow-sm animate-pulse" title={`${label}h — cảnh báo thiếu giờ! ${punchTitle}`}>{label}</span>;
                      }
                    }

                    // --- Cột 2: giờ phép (Off chờ duyệt · AL/UL/... đã duyệt) ---
                    let leaveBadge = <span className="text-slate-300 text-[11px]">-</span>;
                    if (parts.leave) {
                      const { text, tone, leaveType } = parts.leave;
                      const colorByType =
                        leaveType === 'AL' ? 'bg-blue-100 text-blue-800 border-blue-200' :
                        leaveType === 'UL' ? 'bg-slate-200 text-slate-700 border-slate-300' :
                        leaveType === 'SL' ? 'bg-pink-100 text-pink-800 border-pink-200' :
                        leaveType === 'PL' ? 'bg-teal-100 text-teal-800 border-teal-200' :
                        leaveType === 'PH' ? 'bg-amber-100 text-amber-800 border-amber-200' :
                        leaveType === 'BT' ? 'bg-sky-100 text-sky-800 border-sky-200' :
                        leaveType === 'ML' ? 'bg-purple-100 text-purple-800 border-purple-300' :
                        tone === 'rejected' ? 'bg-rose-100 text-rose-800 border-rose-300' :
                        'bg-amber-100 text-amber-800 border-amber-300';
                      const pulse = tone === 'pending' ? ' animate-pulse' : '';
                      const statusLabel = tone === 'pending' ? 'Chờ duyệt bù phép' : tone === 'approved' ? 'Đã duyệt' : tone === 'rejected' ? 'Không phép / bị từ chối' : 'Mã phép tay';
                      leaveBadge = (
                        <span
                          className={`px-1 py-0.5 rounded-md font-bold text-[10px] border whitespace-nowrap${pulse} ${colorByType}`}
                          title={`${text} — ${statusLabel}. Bấm để sang menu bù phép.`}
                        >
                          {text}
                        </span>
                      );
                    }

                    // --- Cột 3: tăng ca (logic Overtime Table giữ nguyên) ---
                    const otHours = parts.ot?.hours || 0;
                    let otBadge: React.ReactNode = (
                      <span
                        onClick={() => handleOpenOtCell(emp, day)}
                        className="text-slate-300 hover:text-orange-500 cursor-pointer p-1 rounded transition text-[11px]"
                        title="Bấm để xem hoặc thêm tăng ca thủ công"
                      >
                        -
                      </span>
                    );
                    if (otHours > 0) {
                      let bgClass = 'bg-amber-100 text-amber-900 border-amber-300';
                      if (parts.ot?.verificationStatus === 'MATCHED') {
                        bgClass = 'bg-emerald-100 text-emerald-900 border-emerald-300 font-extrabold';
                      } else if (parts.ot?.verificationStatus === 'MISMATCH') {
                        bgClass = 'bg-rose-100 text-rose-900 border-rose-300 font-extrabold animate-pulse';
                      }
                      const tooltipLines = [
                        `Tăng ca: ${otHours}h (${parts.ot?.rawMinutes || Math.round(otHours * 60)} phút)`,
                        parts.ot?.startTime && parts.ot?.endTime ? `Khung: ${parts.ot.startTime} - ${parts.ot.endTime}` : '',
                        parts.ot?.isEarlyIn ? '⭐ Có tăng ca vào sớm (06:00 - 06:30)' : '',
                        `Trạng thái: ${parts.ot?.verificationStatus}`,
                        parts.ot?.note ? `Ghi chú: ${parts.ot.note}` : '',
                        'Bấm để chỉnh sửa / làm tròn thủ công'
                      ].filter(Boolean).join('\n');
                      otBadge = (
                        <div className="relative inline-flex items-center justify-center">
                          <span
                            onClick={() => handleOpenOtCell(emp, day)}
                            className={`min-w-[28px] h-6 px-1 rounded-lg font-bold flex items-center justify-center text-[11px] border cursor-pointer hover:scale-110 transition shadow-sm relative ${bgClass}`}
                            title={tooltipLines}
                          >
                            {otHours % 1 === 0 ? otHours : otHours.toFixed(1)}
                            {parts.ot?.isEarlyIn && (
                              <span
                                className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-sky-500 rounded-full border-2 border-white shadow-sm"
                                title="Tăng ca vào sớm (06:00-06:30)"
                              />
                            )}
                          </span>
                        </div>
                      );
                    }

                    const sundayBg = day.isSunday ? 'bg-amber-50/40' : (day.isSaturday ? 'bg-slate-50/40' : '');
                    return (
                      <React.Fragment key={day.dayIndex}>
                        <td onClick={() => handleCellClick(emp, day)} className={`p-1 text-center border-r border-slate-100 cursor-pointer hover:bg-orange-100/50 transition ${sundayBg}`} title={punchTitle}>
                          <div className="flex items-center justify-center">{workBadge}</div>
                        </td>
                        <td
                          onClick={() => onNavigate?.('leavePending')}
                          className={`p-1 text-center border-r border-slate-100 ${onNavigate ? 'cursor-pointer hover:bg-blue-50/60' : ''} transition ${sundayBg}`}
                          title={parts.leave ? `${parts.leave.text} — bấm để sang menu bù phép` : 'Không có giờ phép'}
                        >
                          <div className="flex items-center justify-center">{leaveBadge}</div>
                        </td>
                        <td className={`p-1 text-center border-r border-slate-100 ${sundayBg}`}>
                          <div className="flex items-center justify-center">{otBadge}</div>
                        </td>
                      </React.Fragment>
                    );
                  })}
                  <td className="py-2 px-2 text-center font-bold text-slate-700 border-r border-slate-200 bg-slate-50/50">{summary.standardWD}</td>
                  <td className="py-2 px-2 text-center font-extrabold text-emerald-700 border-r border-slate-200 bg-emerald-50/30">{summary.actualWD}</td>
                  <td className="py-2 px-2 text-center font-bold text-blue-700 border-r border-slate-200">{summary.annualLeaveAL > 0 ? summary.annualLeaveAL : '-'}</td>
                  <td className="py-2 px-2 text-center font-bold text-rose-700 border-r border-slate-200">{summary.unexcusedAbsenceOff > 0 ? summary.unexcusedAbsenceOff : '-'}</td>
                  <td className="py-2 px-2 text-center font-bold text-slate-600 border-r border-slate-200">{summary.unpaidLeaveUL > 0 ? summary.unpaidLeaveUL : '-'}</td>
                  <td className="py-2 px-2 text-center font-bold text-purple-700 border-r border-slate-200">{summary.maternityLeaveML > 0 ? summary.maternityLeaveML : '-'}</td>
                  <td className="py-2 px-2 text-center font-bold text-sky-700 border-r border-slate-200">{summary.businessTripBT > 0 ? summary.businessTripBT : '-'}</td>
                  <td className="py-2 px-2 text-center font-bold text-pink-700 border-r border-slate-200">{summary.sickLeaveSL > 0 ? summary.sickLeaveSL : '-'}</td>
                  <td className="py-2 px-2 text-center font-bold text-amber-700 border-r border-slate-200">{summary.publicHolidayPH > 0 ? summary.publicHolidayPH : '-'}</td>
                  <td className="py-2 px-2 text-center font-bold text-teal-700 border-r border-slate-200">{summary.specialPaidLeavePL > 0 ? summary.specialPaidLeavePL : '-'}</td>
                  <td className="py-2 px-2 text-center font-bold text-indigo-700 border-r border-slate-200">{summary.nightShiftsCount > 0 ? summary.nightShiftsCount : '-'}</td>
                  <td className="py-2 px-2 text-center text-slate-600 border-r border-slate-200 text-[11px]">{summary.lateEarlyMinutes > 0 ? `${summary.lateEarlyMinutes}p` : '-'}</td>
                  <td className="py-2 px-2 text-center font-extrabold text-emerald-600 border-r border-slate-200" title={`Năng suất: ${summary.productivityBonus.toLocaleString()}đ`}>{summary.productivityBonus > 0 ? `${summary.productivityBonus.toLocaleString()}đ` : '-'}</td>
                  <td className="py-2 px-2 text-center font-extrabold text-orange-600 border-r border-slate-200" title={`Chuyên cần: ${summary.diligenceBonus.toLocaleString()}đ`}>{summary.diligenceBonus.toLocaleString()}đ</td>
                  <td className="py-2 px-2 text-center font-bold text-emerald-700 border-r border-slate-200">{summary.extraBonus > 0 ? `+${summary.extraBonus.toLocaleString()}đ` : '-'}</td>
                  <td className="py-2 px-2 text-center font-semibold text-slate-700 border-r border-slate-200">{summary.hazardousAllowance > 0 ? `${summary.hazardousAllowance.toLocaleString()}đ` : '-'}</td>
                  <td className="py-2 px-2 text-center font-semibold text-slate-700 border-r border-slate-200">{summary.pcccAllowance > 0 ? `${summary.pcccAllowance.toLocaleString()}đ` : '-'}</td>
                  <td className="py-2 px-2 text-center font-semibold text-slate-700 border-r border-slate-200">{summary.otherFees > 0 ? `${summary.otherFees.toLocaleString()}đ` : summary.otherFees < 0 ? `${summary.otherFees.toLocaleString()}đ` : '-'}</td>
                  <td className="py-2 px-2 text-center font-semibold text-rose-600">{summary.tradeUnionFee.toLocaleString()}đ</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="p-4 w-full space-y-4 flex-1 flex flex-col">
      <div className="flex flex-col gap-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3">
          <div className="flex-1">
            <h2 className="text-[17px] font-extrabold text-slate-900 flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-orange-500" />
              <span>Bảng chấm công</span>
              <span className="ml-2 px-2.5 py-1 bg-slate-900 text-white rounded-lg text-xs font-black">
                {activeCycle === 'OFFICIAL' ? `Lương tháng ${String(payMonth).padStart(2, '0')}/${payYear}` : `Thời vụ ${String(payMonth).padStart(2, '0')}/${payYear}`}
              </span>
            </h2>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
              {(Object.keys(CLUSTER_META) as TimesheetCluster[]).map((c) => (
                <button
                  key={c}
                  onClick={() => setCluster(c)}
                  className={`px-3 py-1.5 rounded-xl border font-bold flex items-center gap-1.5 transition ${cluster === c ? 'bg-slate-900 text-white border-slate-900 shadow' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
                >
                  {c === 'HC23' ? <Building2 className="w-3.5 h-3.5" /> : c === 'HC_CA' ? <CalendarRange className="w-3.5 h-3.5" /> : <Clock3 className="w-3.5 h-3.5" />}
                  {CLUSTER_META[c].label}
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${cluster === c ? 'bg-white/20' : 'bg-slate-100 text-slate-600'}`}>{clusterCounts[c]}</span>
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 mt-2 leading-relaxed max-w-[880px]">
              Kỳ lương chính thức <b>21 tháng trước – 20 tháng này</b> (VD: 21/9–20/10 là lương tháng 10), thời vụ <b>01–cuối tháng</b> theo timeline riêng. Kỳ đang xem: <b>{payLabel}</b>.
            </p>
            <p className="text-[11px] text-slate-400 mt-1 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-teal-500"></span> PL=Tang/Cưới</span>
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500"></span> PH=Nghỉ lễ</span>
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500"></span> LA/ED 2'-&lt;60', ≥60' chờ bù phép</span>
              <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500"></span> Chuyên cần={systemSettings.diligenceBonusConfig?.baseAmount?.toLocaleString() || '500,000'}đ</span>
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {hasPermission('MANAGE_TIMESHEET') && (
              <button onClick={handleExport} className="flex items-center gap-2 px-3.5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl transition shadow-md shadow-emerald-200">
                <FileSpreadsheet className="w-4 h-4" />
                <span>Xuất Bảng Chốt Công Excel</span>
                <span className="hidden xl:inline text-[10px] opacity-80">({filteredEmployees.length} NV)</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm flex flex-col lg:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2 w-full lg:w-auto flex-1 max-w-2xl">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Tìm theo tên, mã NV..." className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-orange-500" />
          </div>
          <select value={selectedDept} onChange={(e) => setSelectedDept(e.target.value)} className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-orange-500">
            <option value="ALL">Tất cả Phòng Ban</option>
            {departments.map(d => (<option key={d} value={d}>{d}</option>))}
          </select>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-bold text-slate-500 mr-1">Kỳ lương:</span>
          <button onClick={() => shiftPayPeriod(-1)} className="px-3 py-1.5 rounded-xl text-xs font-bold border bg-white text-slate-600 border-slate-200 hover:bg-slate-50 transition" title="Kỳ trước">‹ Trước</button>
          <button onClick={() => shiftPayPeriod(1)} className="px-3 py-1.5 rounded-xl text-xs font-bold border bg-white text-slate-600 border-slate-200 hover:bg-slate-50 transition" title="Kỳ sau">Sau ›</button>
          <button onClick={handleClearTimesheetData} className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold rounded-xl border border-rose-200 transition shadow-sm ml-1" title="Xóa nhanh dữ liệu bảng chấm công để import lại file mới">
            <Trash2 className="w-3.5 h-3.5" />
            <span>Làm sạch bảng công</span>
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap text-[11px] font-semibold text-slate-600 bg-white p-3 rounded-2xl border border-slate-200 shadow-sm">
        <span className="font-bold text-slate-800">Mỗi ngày 3 cột:</span>
        <span className="px-2 py-0.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200">Giờ: 8 đủ công</span>
        <span className="px-2 py-0.5 rounded-lg bg-orange-50 text-orange-700 border border-orange-200">Giờ: 6-7.9 thiếu giờ</span>
        <span className="px-2 py-0.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-200">Giờ: &lt;6 cảnh báo nhấp nháy</span>
        <span className="px-2 py-0.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-200">Phép: 4Off chờ duyệt</span>
        <span className="px-2 py-0.5 rounded-lg bg-blue-50 text-blue-700 border border-blue-200">Phép: 4AL đã duyệt</span>
        <span className="px-2 py-0.5 rounded-lg bg-amber-100 text-amber-900 border border-amber-300">TC: chờ đối soát</span>
        <span className="px-2 py-0.5 rounded-lg bg-emerald-100 text-emerald-900 border border-emerald-300">TC: đã khớp OCR</span>
        <span className="px-2 py-0.5 rounded-lg bg-rose-100 text-rose-900 border border-rose-300">TC: lệch phiếu</span>
        <span className="px-2 py-0.5 rounded-lg bg-purple-50 text-purple-700 border border-purple-200">ML: thai sản</span>
        <span className="px-2 py-0.5 rounded-lg bg-sky-50 text-sky-800 border border-sky-200">BT: công tác</span>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex-1 flex flex-col">
        <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs">
          <span className="font-bold text-slate-800 flex items-center gap-1.5">
            <CalendarRange className="w-4 h-4 text-orange-500"/>
            <span>{CLUSTER_META[cluster].label} — {payLabel}</span>
            <span className="ml-2 px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 text-[10px] font-extrabold">{filteredEmployees.length} nhân viên</span>
          </span>
          <span className="text-slate-500 font-medium">
            {activeCycle === 'OFFICIAL' ? `${calendarDays[0].dayNum}/${calendarDays[0].monthNum} → ${calendarDays[30].dayNum}/${calendarDays[30].monthNum}` : `01/${String(payMonth).padStart(2, '0')} → cuối tháng`}
          </span>
        </div>
        {renderTable(filteredEmployees, calendarDays)}
      </div>

      {filteredEmployees.length===0 && <div className="p-6 text-center text-xs text-slate-500 bg-white rounded-2xl border border-dashed"><AlertTriangle className="w-5 h-5 mx-auto text-amber-500 mb-1"/> Không có dữ liệu nhân viên khớp bộ lọc</div>}

      {activeEditCell && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100">
            <h3 className="text-base font-bold text-slate-900">Chỉnh Sửa Công: {activeEditCell.employee.fullName}</h3>
            <p className="text-xs text-slate-500 mt-1">Mã NV: <b>{activeEditCell.employee.employeeId}</b> | Ngày: <b>{activeEditCell.dateLabel}</b> | {activeEditCell.employee.contractType==='OFFICIAL'?'Chính thức 21-20':'Thời vụ 1-31'}</p>
            <div className="mt-4 p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs space-y-1">
              <div>Giờ vào: <b>{activeEditCell.cell.checkIn || 'Không có quẹt thẻ'}</b></div>
              <div>Giờ ra: <b>{activeEditCell.cell.checkOut || 'Không có quẹt thẻ'}</b></div>
              {activeEditCell.cell.lateMinutes ? (<div className="text-amber-600">Đi trễ: <b>{activeEditCell.cell.lateMinutes} phút</b> {activeEditCell.cell.lateMinutes >= 30 ? <span className="text-rose-600 font-bold">→ chờ duyệt phép</span> : '(LA)'}</div>) : null}
              {activeEditCell.cell.earlyMinutes ? (<div className="text-orange-600">Về sớm: <b>{activeEditCell.cell.earlyMinutes} phút</b> {activeEditCell.cell.earlyMinutes >= 30 ? <span className="text-rose-600 font-bold">→ chờ duyệt phép</span> : '(ED)'}</div>) : null}
              {activeEditCell.cell.violationNote && (<div className="text-slate-600 italic text-[11px] border-t border-slate-200 pt-1 mt-1">{activeEditCell.cell.violationNote}</div>)}
            </div>
            <div className="mt-4">
              <label className="block text-xs font-bold text-slate-700 mb-2">Chọn mã trạng thái công mới:</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { code: 'W', label: 'W: Đi làm đủ' },
                  { code: 'N', label: 'N: Ca đêm' },
                  { code: 'Off', label: 'Off: Chờ bù phép' },
                  { code: 'ML', label: 'ML: Nghỉ thai sản' },
                  { code: 'AL', label: 'AL: Phép năm' },
                  { code: 'UL', label: 'UL: Không lương' },
                  { code: 'SL', label: 'SL: Nghỉ ốm' },
                  { code: 'PL', label: 'PL: Tang/Cưới' },
                  { code: 'PH', label: 'PH: Nghỉ lễ' },
                  { code: 'LA', label: 'LA: Đi trễ' },
                  { code: 'ED', label: 'ED: Về sớm' },
                  { code: 'MCO', label: 'MCO: Không ra' },
                  { code: 'MCI', label: 'MCI: Không vào' },
                  { code: 'BT', label: 'BT: Công tác' },
                  { code: 'W/2 AL/2', label: 'W/2 AL/2: Nửa phép' },
                ].map(item => (
                  <button key={item.code} onClick={() => handleSaveCell(item.code as AttendanceStatusCode)} className={`p-2 rounded-xl text-xs font-bold border transition text-center ${activeEditCell.cell.statusCode === item.code ? 'bg-orange-500 text-white border-orange-500 shadow-md' : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'}`}>{item.label}</button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-slate-100">
              <button onClick={() => setActiveEditCell(null)} className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition">Đóng</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal tăng ca dùng chung với OvertimePage (mở từ cột TC) */}
      {activeOtRecord && (
        <OvertimeEditModal
          key={activeOtRecord.otRecord.employeeId_date}
          employee={activeOtRecord.employee}
          day={activeOtRecord.day}
          otRecord={activeOtRecord.otRecord}
          isNew={!overtimeMap.has(activeOtRecord.otRecord.employeeId_date)}
          onClose={() => setActiveOtRecord(null)}
        />
      )}
    </div>
  );
};
