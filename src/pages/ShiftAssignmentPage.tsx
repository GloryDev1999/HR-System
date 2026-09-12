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
  AlertTriangle
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { ShiftClassType, IEmployee } from '../types';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { logUserAction } from '../services/audit-log-service';

/**
 * Sắp Xếp Ca Làm Việc - Trang mới theo yêu cầu:
 * - Hiển thị danh sách nhân viên, lọc theo bộ phận (10 bộ phận chuẩn)
 * - Chọn ca linh hoạt: SHIFT_1 (06:00-14:00), SHIFT_2 (14:00-22:00), HC (07:30-16:00)
 * - Role-based: WH Admin chỉ thấy WH, Production Admin chỉ thấy Production, QC Admin chỉ thấy QC
 * - Đồng bộ vào db.shiftRosters để Phân Ca & Kiểm Soát Vi Phạm theo dõi cảnh báo, KHÔNG ghi thẳng vào dailyTimesheets/overtimeRecords
 * - Hỗ trợ ngày/tuần/tháng, chọn nhiều, bulk assign
 */

const DEPARTMENTS_STD = [
  'Finance',
  'EHS',
  'Logistics',
  'WH',
  'Production',
  'QC',
  'Maintenance (PRO)',
  'Purchasing',
  'Admin',
  'HR',
] as const;

// Chỉ áp dụng sắp ca cho bộ phận cần xoay ca - hành chính T2-T6 (OFFICE_M_F) bị loại trừ theo yêu cầu
// Mặc định chỉ Production/QC/WH, các bộ phận khác sẽ cấu hình sau (có thể mở rộng qua hằng này)
const SHIFT_ELIGIBLE_DEPARTMENTS: string[] = ['Production', 'QC', 'WH'];
const OFFICE_EXCLUDED_SHIFT: ShiftClassType = 'OFFICE_M_F';

const SHIFT_OPTIONS: { value: ShiftClassType; label: string; time: string }[] = [
  { value: 'SHIFT_1', label: 'Ca 1', time: '06:00 - 14:00' },
  { value: 'SHIFT_2', label: 'Ca 2', time: '14:00 - 22:00' },
  { value: 'OFFICE_M_S', label: 'HC (T2-T7)', time: '07:30 - 16:00' },
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
    // Tuần: 7 ngày từ baseDate (Thứ 2?) - đơn giản: 7 ngày liên tiếp từ baseDate
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) dates.push(addDays(baseDateStr, i));
    return dates;
  }
  // month: tất cả ngày trong tháng của baseDate
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

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDept, setSelectedDept] = useState<string>(departmentScope || 'ALL');
  const [mode, setMode] = useState<'day' | 'week' | 'month'>('day');
  const [baseDate, setBaseDate] = useState<string>(toDateStr(new Date()));
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<Set<string>>(new Set());
  const [shiftSelections, setShiftSelections] = useState<Record<string, ShiftClassType>>({});
  const [bulkShift, setBulkShift] = useState<ShiftClassType>('SHIFT_1');

  const employees = useLiveQuery(() => db.employees.toArray(), []) || [];
  const shiftRosters = useLiveQuery(() => db.shiftRosters.toArray(), []) || [];

  // Role-based + loại trừ hành chính T2-T6 + chỉ bộ phận cần xoay ca
  const visibleEmployees = useMemo(() => {
    let list = employees;
    // Loại trừ hành chính văn phòng T2-T6 (OFFICE_M_F) - không xuất hiện trong menu này
    list = list.filter(e => e.shiftClassId !== OFFICE_EXCLUDED_SHIFT);
    // Chỉ hiển thị bộ phận cần sắp ca (Production/QC/WH và cấu hình sau) - đồng bộ với yêu cầu
    list = list.filter(e => SHIFT_ELIGIBLE_DEPARTMENTS.includes(e.department));
    if (departmentScope) {
      list = list.filter(e => e.department === departmentScope);
    }
    if (selectedDept !== 'ALL') {
      list = list.filter(e => e.department === selectedDept);
    }
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter(e => e.employeeId.toLowerCase().includes(q) || e.fullName.toLowerCase().includes(q));
    }
    return list;
  }, [employees, departmentScope, selectedDept, searchTerm]);

  // Lấy ca hiện tại cho mỗi NV vào ngày baseDate (để hiển thị)
  const currentShiftMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of shiftRosters) {
      if (r.date === baseDate) {
        map.set(r.employeeId, r.shiftCode);
      }
    }
    return map;
  }, [shiftRosters, baseDate]);

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
    info('Đã áp dụng ca hàng loạt', `Đã gán ${bulkShift} cho ${selectedEmployeeIds.size} nhân viên đã chọn. Bấm "Lưu sắp ca" để đồng bộ.`);
  };

  const handleSave = async () => {
    if (!hasPermission('MANAGE_ROSTER') && !hasPermission('MANAGE_DEPT_ROSTER')) {
      error('Không đủ quyền', 'Bạn không có quyền sắp xếp ca (MANAGE_ROSTER).');
      return;
    }
    const entries = Object.entries(shiftSelections).filter(([empId]) => visibleEmployees.some(e => e.employeeId === empId));
    if (entries.length === 0) {
      warning('Chưa chọn ca', 'Vui lòng chọn ca cho ít nhất 1 nhân viên (dùng dropdown hoặc Áp dụng hàng loạt).');
      return;
    }

    const dateRange = getDateRange(mode, baseDate);
    // Nếu chọn nhiều ngày (week/month), sẽ tạo bản ghi cho mỗi ngày trong range cho mỗi NV đã chọn ca
    const toSave: import('../types').IShiftRosterEntry[] = [];
    for (const [empId, shiftCode] of entries) {
      const emp = employees.find(e => e.employeeId === empId);
      if (!emp) continue;
      const { start, end } = getShiftTime(shiftCode);
      for (const dateStr of dateRange) {
        // Kiểm tra ca trước để tính vi phạm 12h (giống ShiftRosterPage)
        const prevDate = addDays(dateStr, -1);
        const prevRoster = toSave.find(r => r.employeeId === empId && r.date === prevDate)
          || shiftRosters.find(r => r.employeeId === empId && r.date === prevDate);
        const prevEnd = prevRoster?.endTime;
        let isViolating = false;
        let restHours = 16;
        let violationDetails: string | undefined;

        if (prevEnd === '22:00') {
          if (shiftCode === 'SHIFT_1') {
            isViolating = true;
            restHours = 8;
            violationDetails = 'Nghỉ 8 giờ giữa Ca 2 (kết thúc 22h) và Ca 1 (bắt đầu 06h) < 12h';
          } else if (shiftCode === 'OFFICE_M_F' || (shiftCode as any) === 'OFFICE_M_S') {
            isViolating = true;
            restHours = 9.5;
            violationDetails = 'Nghỉ 9.5 giờ giữa Ca 2 (kết thúc 22h) và Giờ hành chính (bắt đầu 07h30) < 12h';
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

    try {
      // Đồng bộ cả shiftRosters và danh mục nhân viên (cột Nhóm Ca) trong cùng transaction
      await db.transaction('rw', db.shiftRosters, db.employees, async () => {
        await db.shiftRosters.bulkPut(toSave);
        // Đồng bộ Nhóm Ca Làm Việc cho từng NV - cập nhật shiftClassId (loại trừ OFFICE_M_F đã lọc)
        for (const [empId, shiftCode] of entries) {
          await db.employees.update(empId, { shiftClassId: shiftCode });
        }
      });
      success('Đã lưu sắp xếp ca', `Đã lưu ${toSave.length} bản ghi (${entries.length} NV × ${dateRange.length} ngày) và đồng bộ Nhóm Ca cho ${entries.length} NV. Phân Ca & Kiểm Soát sẽ cảnh báo nếu sai.`);
      info('Đồng bộ', 'Đã đồng bộ với Danh Mục Nhân Viên (Nhóm Ca) và Phân Ca & Xoay Ca. Khi nạp dữ liệu chấm công, hệ thống sẽ so sánh và cảnh báo nếu đi sai ca.');

      if (session) {
        logUserAction({
          username: session.username,
          displayName: session.displayName,
          role: session.role,
          actionType: 'ASSIGN_SHIFT',
          targetEntity: `${departmentScope || selectedDept} (${entries.length} NV)`,
          details: `Sắp xếp ca cho ${entries.length} nhân viên trong ${dateRange.length} ngày (${dateRange[0]} -> ${dateRange[dateRange.length - 1]})`
        }).catch(console.error);
      }
    } catch (err: any) {
      error('Lỗi lưu ca', err.message);
    }
  };

  const canManage = hasPermission('MANAGE_ROSTER') || hasPermission('MANAGE_DEPT_ROSTER');

  return (
    <div className="p-6 w-full space-y-6 flex-1 flex flex-col font-sans">
      {/* Header */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
            <Briefcase className="w-5 h-5 text-orange-500" />
            <span>Sắp Xếp Ca Làm Việc</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Chọn ngày/tuần/tháng, lọc theo bộ phận, chọn ca cho từng nhân viên. Dữ liệu đồng bộ với Phân Ca & Kiểm Soát Vi Phạm để cảnh báo khi đi sai ca. Không ghi trực tiếp vào bảng chấm công.
          </p>
          {departmentScope && (
            <p className="text-[11px] text-amber-700 mt-1 bg-amber-50 border border-amber-200 rounded px-2 py-1 inline-block">
              Bạn là {currentRole} - chỉ hiển thị nhân viên bộ phận {departmentScope}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500 hidden lg:inline">Hiển thị {visibleEmployees.length} NV • {selectedEmployeeIds.size} đã chọn</span>
        </div>
      </div>

      {/* Filter & Bulk Toolbar */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-4">
        <div className="flex flex-col lg:flex-row gap-3 items-start lg:items-center justify-between">
          <div className="flex flex-wrap items-center gap-3 flex-1">
            {/* Search */}
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Tìm tên, mã NV..."
                className="pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs w-56 focus:outline-none focus:border-orange-500"
              />
            </div>

            {/* Department filter - chỉ Production/QC/WH (cấu hình sau mở rộng), loại trừ HC T2-T6 */}
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-slate-500" />
              <select
                value={selectedDept}
                onChange={(e) => setSelectedDept(e.target.value)}
                disabled={!!departmentScope}
                className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:border-orange-500 disabled:opacity-60"
                title={departmentScope ? `Đã khóa theo quyền ${currentRole}: ${departmentScope}` : 'Lọc theo bộ phận (chỉ Production/QC/WH, cấu hình sau mở rộng)'}
              >
                <option value="ALL">Tất cả bộ phận (đã lọc HC T2-T6)</option>
                {SHIFT_ELIGIBLE_DEPARTMENTS.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>

            {/* Date mode */}
            <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1">
              {(['day', 'week', 'month'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${mode === m ? 'bg-white shadow-sm text-slate-900 border border-slate-200' : 'text-slate-600 hover:text-slate-900'}`}
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

          {/* Bulk controls */}
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
              <span>Áp dụng cho {selectedEmployeeIds.size || 'đã chọn'}</span>
            </button>
            <button
              onClick={handleSave}
              disabled={!canManage}
              className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm disabled:opacity-40"
            >
              <Save className="w-4 h-4" />
              <span>Lưu sắp ca ({mode === 'day' ? '1 ngày' : mode === 'week' ? '7 ngày' : 'cả tháng'})</span>
            </button>
          </div>
        </div>

        <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
          Chế độ <b>{mode === 'day' ? 'Ngày' : mode === 'week' ? 'Tuần (7 ngày)' : 'Tháng'}</b> từ <b>{baseDate}</b> {mode !== 'day' && <>→ {getDateRange(mode, baseDate).length} ngày</>} • Ca: <b>Ca 1 (06:00-14:00)</b>, <b>Ca 2 (14:00-22:00)</b>, <b>HC T2-T7 (07:30-16:00)</b> (Không sắp vào HC Văn phòng T2-T6) • Chọn nhiều nhân viên + bulk để sắp nhanh.
        </div>
      </div>

      {/* Employee Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex-1">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
              <tr>
                <th className="py-3 px-3 w-10">
                  <button onClick={toggleSelectAll} className="text-slate-600 hover:text-slate-900" title="Chọn tất cả đã lọc">
                    {selectedEmployeeIds.size === visibleEmployees.length && visibleEmployees.length > 0 ? <CheckSquare className="w-4 h-4 text-orange-500" /> : <Square className="w-4 h-4" />}
                  </button>
                </th>
                <th className="py-3 px-3">Mã NV</th>
                <th className="py-3 px-3">Họ Tên</th>
                <th className="py-3 px-3">Bộ Phận</th>
                <th className="py-3 px-3 text-center">Ca hiện tại ({baseDate})</th>
                <th className="py-3 px-3 text-center">Chọn ca</th>
                <th className="py-3 px-3 text-center">Trạng thái</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleEmployees.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400 text-xs">
                    Không có nhân viên nào khớp bộ lọc{departmentScope ? ` (bộ phận ${departmentScope})` : ''}.
                  </td>
                </tr>
              )}
              {visibleEmployees.map(emp => {
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
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer actions mobile */}
      <div className="flex items-center justify-between bg-white p-3 rounded-2xl border border-slate-200 shadow-sm">
        <div className="text-[11px] text-slate-500">
          Đã chọn <b>{selectedEmployeeIds.size}</b> / {visibleEmployees.length} NV • Chế độ {mode} • {getDateRange(mode, baseDate).length} ngày sẽ được tạo
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSelectedEmployeeIds(new Set())}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-semibold"
          >
            Bỏ chọn
          </button>
          <button
            onClick={handleSave}
            disabled={!canManage}
            className="px-4 py-1.5 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 disabled:opacity-40"
          >
            <Save className="w-3.5 h-3.5" /> Lưu
          </button>
        </div>
      </div>
    </div>
  );
};
