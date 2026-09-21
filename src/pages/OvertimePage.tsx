import React, { useState, useMemo, useEffect } from 'react';
import { 
  Clock, 
  Search, 
  Filter, 
  CheckCircle2, 
  AlertTriangle, 
  ScanLine, 
  FileSpreadsheet,
  CalendarRange,
  Building2,
  Sparkles,
  ArrowRight,
  SunMedium,
  Check,
  X,
  Edit3
} from 'lucide-react';
import { useLiveTable, upsertOne } from '../lib/tables';
import type { IEmployee, IOvertimeRecord, OvertimeVerificationStatus } from '../types';
import { generateCalendarDays, CalendarDay } from '../services/calendar-utils';
import { formatPayPeriodLabel } from '../services/pay-period';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';
import { useAuth } from '../context/AuthContext';
import { NavPageId } from '../components/layout/Sidebar';

interface OvertimePageProps {
  onNavigate: (page: NavPageId) => void;
}

interface ActiveEditRecordState {
  employee: IEmployee;
  otRecord: IOvertimeRecord;
  day: CalendarDay;
  hours: number;
  note: string;
  verificationStatus: OvertimeVerificationStatus;
}

export const OvertimePage: React.FC<OvertimePageProps> = ({ onNavigate }) => {
  const { success, warning, error } = useToast();
  const { confirm } = useModal();
  const { departmentScope, hasPermission } = useAuth();

  const [cycleMode, setCycleMode] = useState<'SEASONAL' | 'OFFICIAL'>('OFFICIAL');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDept, setSelectedDept] = useState<string>('ALL');

  const [selectedMonth, setSelectedMonth] = useState<number>(() => {
    const saved = localStorage.getItem('smarthr_selected_month');
    return saved ? parseInt(saved, 10) : 8;
  });
  const [selectedYear, setSelectedYear] = useState<number>(() => {
    const saved = localStorage.getItem('smarthr_selected_year');
    return saved ? parseInt(saved, 10) : 2026;
  });

  // Tự động đồng bộ tháng/năm khi nạp file chấm công mới
  useEffect(() => {
    const handler = (e: any) => {
      if (e.detail?.month) setSelectedMonth(e.detail.month);
      if (e.detail?.year) setSelectedYear(e.detail.year);
    };
    window.addEventListener('timesheet:period_changed', handler);
    return () => window.removeEventListener('timesheet:period_changed', handler);
  }, []);

  // Modal chỉnh sửa OT thủ công
  const [activeEditRecord, setActiveEditRecord] = useState<ActiveEditRecordState | null>(null);

  // Live queries (Supabase realtime)
  const employees = useLiveTable<IEmployee>('employees');
  const overtimes = useLiveTable<IOvertimeRecord>('overtimeRecords');

  // Filter employees
  const filteredEmployees = useMemo(() => {
    return employees.filter(emp => {
      if (departmentScope && emp.department !== departmentScope) return false;
      if (selectedDept !== 'ALL' && emp.department !== selectedDept) return false;
      if (emp.contractType && emp.contractType !== cycleMode) return false;
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        const m1 = emp.employeeId.toLowerCase().includes(q);
        const m2 = emp.fullName.toLowerCase().includes(q);
        if (!m1 && !m2) return false;
      }
      return true;
    });
  }, [employees, departmentScope, selectedDept, cycleMode, searchTerm]);

  const departments = Array.from(new Set(employees.map(e => e.department))).filter(Boolean);

  // Fast map of overtimes
  const overtimeMap = useMemo(() => {
    const map = new Map<string, IOvertimeRecord>();
    overtimes.forEach(ot => map.set(ot.employeeId_date, ot));
    return map;
  }, [overtimes]);

  // Calendar 31-day definition theo chu kỳ
  const calendarDays = useMemo(() => {
    return generateCalendarDays(selectedMonth, selectedYear, cycleMode);
  }, [selectedMonth, selectedYear, cycleMode]);

  const payPeriodLabel = useMemo(() => {
    return formatPayPeriodLabel(selectedMonth, selectedYear, cycleMode);
  }, [selectedMonth, selectedYear, cycleMode]);

  // Total summary OT statistics (scoped theo kỳ công và bộ phận đang chọn)
  const otSummary = useMemo(() => {
    let totalOTHours = 0;
    let pendingCount = 0;
    let verifiedCount = 0;
    let mismatchCount = 0;
    let earlyInCount = 0;

    const activeDates = new Set(calendarDays.map(d => d.dateStr));
    const activeEmpIds = new Set(filteredEmployees.map(e => e.employeeId));

    overtimes.forEach(ot => {
      if (!activeDates.has(ot.date)) return;
      if (!activeEmpIds.has(ot.employeeId)) return;
      totalOTHours += ot.hours;
      if (ot.verificationStatus === 'PENDING') pendingCount++;
      else if (ot.verificationStatus === 'MATCHED') verifiedCount++;
      else if (ot.verificationStatus === 'MISMATCH') mismatchCount++;
      if (ot.isEarlyIn) earlyInCount++;
    });

    return {
      totalOTHours: totalOTHours.toFixed(2),
      pendingCount,
      verifiedCount,
      mismatchCount,
      earlyInCount
    };
  }, [overtimes, calendarDays, filteredEmployees]);

  const canManageOt = hasPermission('MANAGE_OT') || hasPermission('PROPOSE_DEPT_OT');

  // Mở modal xem / chỉnh sửa giờ OT và làm tròn thủ công
  const handleOpenCellModal = (emp: IEmployee, day: CalendarDay) => {
    if (!canManageOt) {
      warning('Không đủ quyền', 'Bạn không có quyền quản lý tăng ca (MANAGE_OT hoặc PROPOSE_DEPT_OT).');
      return;
    }

    const key = `${emp.employeeId}_${day.dateStr}`;
    const existing = overtimeMap.get(key);

    if (existing) {
      setActiveEditRecord({
        employee: emp,
        otRecord: existing,
        day,
        hours: existing.hours,
        note: existing.note || '',
        verificationStatus: existing.verificationStatus
      });
    } else {
      // Cho phép HR thêm mới thủ công nếu muốn
      setActiveEditRecord({
        employee: emp,
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
        day,
        hours: 0,
        note: '',
        verificationStatus: 'PENDING'
      });
    }
  };

  // Lưu bản ghi OT sau khi chỉnh sửa
  const handleSaveOtRecord = async () => {
    if (!activeEditRecord) return;
    if (!canManageOt) {
      error('Không đủ quyền', 'Bạn không có quyền lưu giờ tăng ca.');
      return;
    }
    try {
      const updated: IOvertimeRecord = {
        ...activeEditRecord.otRecord,
        hours: Number(activeEditRecord.hours),
        note: activeEditRecord.note.trim(),
        verificationStatus: activeEditRecord.verificationStatus,
        verifiedAt: new Date().toISOString()
      };

      if (updated.hours <= 0 && !overtimeMap.has(updated.employeeId_date)) {
        setActiveEditRecord(null);
        return;
      }

      await upsertOne('overtimeRecords', updated);
      success('Đã lưu tăng ca', `Đã cập nhật ${updated.hours}h tăng ca cho ${activeEditRecord.employee.fullName}`);
      setActiveEditRecord(null);
    } catch (err: any) {
      error('Lỗi khi lưu tăng ca', err.message);
    }
  };

  return (
    <div className="p-6 w-full space-y-6 flex-1 flex flex-col">
      {/* Top Banner */}
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Clock className="w-5 h-5 text-orange-500" />
            <span>Bảng Theo Dõi & Quản Lý Tăng Ca (Overtime Table)</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Số giờ tăng ca thực tế được tính tự động (không làm tròn tự động). HR có thể bấm vào ô để xem chi tiết và tự làm tròn thủ công.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate('ocrVerification')}
            className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-orange-500 to-rose-500 hover:from-orange-600 hover:to-rose-600 text-white text-xs font-bold rounded-xl transition shadow-md shadow-orange-200"
          >
            <ScanLine className="w-4 h-4" />
            <span>Quét Phiếu Đối Soát OCR</span>
          </button>
        </div>
      </div>

      {/* KPI Cards for OT */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
          <div className="text-xs font-bold text-slate-400 uppercase">Tổng Giờ Tăng Ca</div>
          <div className="text-2xl font-extrabold text-slate-900 mt-1">{otSummary.totalOTHours} <span className="text-xs font-medium text-slate-500">giờ</span></div>
        </div>

        <div className="bg-amber-50/50 p-4 rounded-2xl border border-amber-200 shadow-sm">
          <div className="text-xs font-bold text-amber-800 uppercase flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-500" />
            Chờ Đối Soát (Vàng)
          </div>
          <div className="text-2xl font-extrabold text-amber-700 mt-1">{otSummary.pendingCount} <span className="text-xs font-medium">bản ghi</span></div>
        </div>

        <div className="bg-emerald-50/50 p-4 rounded-2xl border border-emerald-200 shadow-sm">
          <div className="text-xs font-bold text-emerald-800 uppercase flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Đã Khớp OCR (Xanh)
          </div>
          <div className="text-2xl font-extrabold text-emerald-700 mt-1">{otSummary.verifiedCount} <span className="text-xs font-medium">bản ghi</span></div>
        </div>

        <div className="bg-rose-50/50 p-4 rounded-2xl border border-rose-200 shadow-sm">
          <div className="text-xs font-bold text-rose-800 uppercase flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-rose-500" />
            Lệch OCR (Đỏ)
          </div>
          <div className="text-2xl font-extrabold text-rose-700 mt-1">{otSummary.mismatchCount} <span className="text-xs font-medium">bản ghi</span></div>
        </div>

        <div className="bg-sky-50/50 p-4 rounded-2xl border border-sky-200 shadow-sm">
          <div className="text-xs font-bold text-sky-800 uppercase flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-sky-500" />
            Tăng Ca Vào Sớm
          </div>
          <div className="text-2xl font-extrabold text-sky-700 mt-1">{otSummary.earlyInCount} <span className="text-xs font-medium">ca 06:00-06:30</span></div>
        </div>
      </div>

      {/* Filters Toolbar & Cycle Selector */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3 w-full md:w-auto flex-1 max-w-xl">
          {/* Chế độ chu kỳ */}
          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
            <button
              onClick={() => setCycleMode('OFFICIAL')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
                cycleMode === 'OFFICIAL' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span>Chính thức (21-20)</span>
            </button>
            <button
              onClick={() => setCycleMode('SEASONAL')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
                cycleMode === 'SEASONAL' ? 'bg-white text-orange-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <span>Thời vụ (1-31)</span>
            </button>
          </div>

          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Tìm theo tên, mã NV..."
              className="w-full pl-9 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-orange-500"
            />
          </div>

          <select
            value={selectedDept}
            onChange={(e) => setSelectedDept(e.target.value)}
            className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-orange-500"
          >
            <option value="ALL">Tất cả Phòng Ban</option>
            {departments.map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-2 text-xs font-semibold flex-wrap">
          <span className="px-2.5 py-1 rounded-lg bg-amber-100 text-amber-900 border border-amber-300">Vàng: Chờ xác nhận</span>
          <span className="px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-900 border border-emerald-300">Xanh: Đã khớp OCR</span>
          <span className="px-2.5 py-1 rounded-lg bg-rose-100 text-rose-900 border border-rose-300">Đỏ: Lệch phiếu duyệt</span>
          <span className="px-2.5 py-1 rounded-lg bg-sky-50 text-sky-800 border border-sky-300 flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-sky-500" />
            Chấm xanh: Vào sớm (06:00-06:30)
          </span>
        </div>
      </div>

      {/* Overtime Matrix Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex-1 flex flex-col">
        <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs">
          <span className="font-bold text-slate-800 flex items-center gap-1.5">
            <CalendarRange className="w-4 h-4 text-orange-500" />
            <span>Kỳ công {cycleMode === 'OFFICIAL' ? 'Chính thức (21-20)' : 'Thời vụ (1-31)'} — {payPeriodLabel}</span>
            <span className="ml-2 px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 text-[10px] font-extrabold">{filteredEmployees.length} nhân viên</span>
          </span>
          <span className="text-slate-500 font-medium">
            {cycleMode === 'OFFICIAL' ? `${calendarDays[0]?.dayNum}/${calendarDays[0]?.monthNum} → ${calendarDays[30]?.dayNum}/${calendarDays[30]?.monthNum}` : `01/${String(selectedMonth).padStart(2,'0')} → cuối tháng`}
          </span>
        </div>

        <div className="overflow-x-auto overflow-y-auto max-h-[70vh] flex-1">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-900 text-white font-bold sticky top-0 z-30 shadow-md">
              <tr>
                <th className="py-2.5 px-3 bg-slate-900 sticky left-0 z-40 w-12 text-center border-r border-slate-800">#</th>
                <th className="py-2.5 px-3 bg-slate-900 sticky left-12 z-40 w-24 border-r border-slate-800">Mã NV</th>
                <th className="py-2.5 px-4 bg-slate-900 sticky left-36 z-40 min-w-[180px] border-r border-slate-800">Họ và Tên</th>
                <th className="py-2.5 px-3 bg-slate-900 sticky left-[324px] z-40 w-28 border-r border-slate-800">Bộ Phận</th>

                {/* 31 Calendar Columns */}
                {calendarDays.map((day) => (
                  <th
                    key={day.dayIndex}
                    className={`py-1.5 px-1 text-center min-w-[38px] border-r border-slate-800 select-none ${
                      day.isSunday ? 'bg-amber-950/80 text-amber-200' : 'bg-slate-900'
                    }`}
                  >
                    <div className="text-[10px] opacity-75">{day.dayVi}</div>
                    <div className="text-xs font-bold">{day.dayNum}</div>
                  </th>
                ))}

                <th className="py-2.5 px-4 bg-orange-950 text-orange-200 text-center min-w-[100px]">Tổng Giờ OT</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-200 bg-white">
              {filteredEmployees.map((emp, empIdx) => {
                let empTotalOT = 0;

                return (
                  <tr key={emp.employeeId} className="hover:bg-orange-50/30 transition group">
                    <td className="py-2 px-3 bg-white group-hover:bg-orange-50/50 sticky left-0 z-20 text-center font-semibold text-slate-400 border-r border-slate-200">
                      {empIdx + 1}
                    </td>
                    <td className="py-2 px-3 bg-white group-hover:bg-orange-50/50 sticky left-12 z-20 font-bold text-slate-900 border-r border-slate-200">
                      <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-800 font-mono text-[11px]">
                        {emp.employeeId}
                      </span>
                    </td>
                    <td className="py-2 px-4 bg-white group-hover:bg-orange-50/50 sticky left-36 z-20 font-bold text-slate-800 border-r border-slate-200 whitespace-nowrap">
                      {emp.fullName}
                    </td>
                    <td className="py-2 px-3 bg-white group-hover:bg-orange-50/50 sticky left-[324px] z-20 font-semibold text-slate-600 border-r border-slate-200">
                      {emp.department}
                    </td>

                    {/* 31 Calendar OT cells */}
                    {calendarDays.map((day) => {
                      const key = `${emp.employeeId}_${day.dateStr}`;
                      const otRecord = overtimeMap.get(key);
                      const hours = otRecord?.hours || 0;
                      if (hours > 0) empTotalOT += hours;

                      let cellBadge = (
                        <span 
                          onClick={() => handleOpenCellModal(emp, day)}
                          className="text-slate-300 hover:text-orange-500 cursor-pointer p-1 rounded transition"
                          title="Bấm để xem hoặc thêm tăng ca thủ công"
                        >
                          -
                        </span>
                      );

                      if (hours > 0) {
                        let bgClass = 'bg-amber-100 text-amber-900 border-amber-300';
                        if (otRecord?.verificationStatus === 'MATCHED') {
                          bgClass = 'bg-emerald-100 text-emerald-900 border-emerald-300 font-extrabold';
                        } else if (otRecord?.verificationStatus === 'MISMATCH') {
                          bgClass = 'bg-rose-100 text-rose-900 border-rose-300 font-extrabold animate-pulse';
                        }

                        const tooltipLines = [
                          `Tăng ca: ${hours}h (${otRecord?.rawMinutes || Math.round(hours * 60)} phút)`,
                          otRecord?.startTime && otRecord?.endTime ? `Khung: ${otRecord.startTime} - ${otRecord.endTime}` : '',
                          otRecord?.isEarlyIn ? '⭐ Có tăng ca vào sớm (06:00 - 06:30)' : '',
                          `Trạng thái: ${otRecord?.verificationStatus}`,
                          otRecord?.note ? `Ghi chú: ${otRecord.note}` : '',
                          'Bấm để chỉnh sửa / làm tròn thủ công'
                        ].filter(Boolean).join('\n');

                        cellBadge = (
                          <div className="relative inline-flex items-center justify-center">
                            <span
                              onClick={() => handleOpenCellModal(emp, day)}
                              className={`w-7 h-7 rounded-lg font-bold flex items-center justify-center text-[11px] border cursor-pointer hover:scale-110 transition shadow-sm relative ${bgClass}`}
                              title={tooltipLines}
                            >
                              {hours % 1 === 0 ? hours : hours.toFixed(1)}
                              {otRecord?.isEarlyIn && (
                                <span 
                                  className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-sky-500 rounded-full border-2 border-white shadow-sm"
                                  title="Tăng ca vào sớm (06:00-06:30)"
                                />
                              )}
                            </span>
                          </div>
                        );
                      }

                      return (
                        <td
                          key={day.dayIndex}
                          className={`p-1 text-center border-r border-slate-100 ${
                            day.isSunday ? 'bg-amber-50/40' : ''
                          }`}
                        >
                          <div className="flex items-center justify-center">
                            {cellBadge}
                          </div>
                        </td>
                      );
                    })}

                    <td className="py-2 px-4 text-center font-extrabold text-orange-600 bg-orange-50/40">
                      {empTotalOT > 0 ? `${empTotalOT.toFixed(2)}h` : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {filteredEmployees.length === 0 && (
        <div className="p-8 text-center text-xs text-slate-500 bg-white rounded-2xl border border-dashed">
          <AlertTriangle className="w-6 h-6 mx-auto text-amber-500 mb-2" />
          Không có dữ liệu nhân viên khớp với bộ lọc nhóm {cycleMode === 'OFFICIAL' ? 'Chính thức' : 'Thời vụ'}
        </div>
      )}

      {/* Modal Chỉnh sửa Giờ Tăng Ca / Làm Tròn Thủ Công */}
      {activeEditRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-orange-500" />
                <h3 className="text-base font-bold text-slate-900">Chi Tiết Tăng Ca (Overtime)</h3>
              </div>
              <button 
                onClick={() => setActiveEditRecord(null)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs space-y-1.5">
              <div>Nhân viên: <b className="text-slate-900">{activeEditRecord.employee.fullName}</b> ({activeEditRecord.employee.employeeId})</div>
              <div>Ngày: <b>{activeEditRecord.day.dayVi}, {activeEditRecord.day.dateStr}</b> ({activeEditRecord.day.isSunday ? 'Chủ Nhật' : 'Ngày thường'})</div>
              {activeEditRecord.otRecord.startTime && activeEditRecord.otRecord.endTime ? (
                <div>Khung giờ: <b>{activeEditRecord.otRecord.startTime} → {activeEditRecord.otRecord.endTime}</b></div>
              ) : null}
              <div>Số phút quẹt thẻ thực tế: <b>{activeEditRecord.otRecord.rawMinutes || Math.round(activeEditRecord.otRecord.hours * 60)} phút</b></div>
              {activeEditRecord.otRecord.isEarlyIn && (
                <div className="text-sky-700 font-bold flex items-center gap-1 bg-sky-100 p-1.5 rounded-lg">
                  <span className="w-2 h-2 rounded-full bg-sky-500" />
                  Có tăng ca vào sớm trong khung 06:00 - 06:30
                </div>
              )}
            </div>

            {/* Input số giờ tăng ca (HR tự làm tròn) */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Số giờ tăng ca (HR tự làm tròn theo quy định):
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="24"
                  value={activeEditRecord.hours}
                  onChange={(e) => setActiveEditRecord({
                    ...activeEditRecord,
                    hours: parseFloat(e.target.value) || 0
                  })}
                  className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-orange-600 focus:outline-none focus:border-orange-500"
                />
                <span className="text-xs font-semibold text-slate-500">giờ</span>
              </div>

              {/* Quick round helpers */}
              <div className="flex items-center gap-1.5 mt-2">
                <span className="text-[11px] text-slate-400">Làm tròn nhanh:</span>
                <button
                  type="button"
                  onClick={() => setActiveEditRecord({
                    ...activeEditRecord,
                    hours: Math.round(activeEditRecord.hours)
                  })}
                  className="px-2 py-0.5 text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition"
                >
                  Về chẵn (.0)
                </button>
                <button
                  type="button"
                  onClick={() => setActiveEditRecord({
                    ...activeEditRecord,
                    hours: Math.round(activeEditRecord.hours * 2) / 2
                  })}
                  className="px-2 py-0.5 text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition"
                >
                  Về nửa giờ (.5)
                </button>
                {activeEditRecord.otRecord.rawMinutes ? (
                  <button
                    type="button"
                    onClick={() => setActiveEditRecord({
                      ...activeEditRecord,
                      hours: +(activeEditRecord.otRecord.rawMinutes! / 60).toFixed(2)
                    })}
                    className="px-2 py-0.5 text-[11px] font-semibold bg-orange-50 hover:bg-orange-100 text-orange-700 rounded-lg transition"
                  >
                    Thực tế ({+(activeEditRecord.otRecord.rawMinutes / 60).toFixed(2)}h)
                  </button>
                ) : null}
              </div>
            </div>

            {/* Trạng thái xác nhận */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Trạng thái xác nhận / đối soát:
              </label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setActiveEditRecord({ ...activeEditRecord, verificationStatus: 'PENDING' })}
                  className={`p-2 rounded-xl text-xs font-bold border transition text-center ${
                    activeEditRecord.verificationStatus === 'PENDING'
                      ? 'bg-amber-500 text-white border-amber-500 shadow-md'
                      : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                  }`}
                >
                  Chờ xác nhận
                </button>
                <button
                  type="button"
                  onClick={() => setActiveEditRecord({ ...activeEditRecord, verificationStatus: 'MATCHED' })}
                  className={`p-2 rounded-xl text-xs font-bold border transition text-center ${
                    activeEditRecord.verificationStatus === 'MATCHED'
                      ? 'bg-emerald-600 text-white border-emerald-600 shadow-md'
                      : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                  }`}
                >
                  Đã khớp OCR
                </button>
                <button
                  type="button"
                  onClick={() => setActiveEditRecord({ ...activeEditRecord, verificationStatus: 'MISMATCH' })}
                  className={`p-2 rounded-xl text-xs font-bold border transition text-center ${
                    activeEditRecord.verificationStatus === 'MISMATCH'
                      ? 'bg-rose-600 text-white border-rose-600 shadow-md'
                      : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                  }`}
                >
                  Lệch phiếu
                </button>
              </div>
            </div>

            {/* Ghi chú */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Ghi chú tăng ca:</label>
              <textarea
                value={activeEditRecord.note}
                onChange={(e) => setActiveEditRecord({ ...activeEditRecord, note: e.target.value })}
                rows={2}
                placeholder="Nhập ghi chú hoặc lý do điều chỉnh..."
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-orange-500 resize-none"
              />
            </div>

            {/* Buttons */}
            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setActiveEditRecord(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={handleSaveOtRecord}
                className="px-4 py-2 text-xs font-bold text-white bg-orange-500 hover:bg-orange-600 rounded-xl shadow-md shadow-orange-200 transition"
              >
                Lưu thay đổi
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
