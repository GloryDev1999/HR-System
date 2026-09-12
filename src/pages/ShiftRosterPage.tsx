import React, { useState, useMemo } from 'react';
import { 
  RotateCcw, 
  Search, 
  AlertTriangle, 
  CheckCircle2, 
  ShieldAlert, 
  Clock, 
  Calendar, 
  Plus,
  ArrowRightLeft,
  UserCheck
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { IShiftRosterEntry, ShiftClassType, IEmployee } from '../types';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';
import { useAuth } from '../context/AuthContext';
import { logUserAction } from '../services/audit-log-service';

export const ShiftRosterPage: React.FC = () => {
  const { success, warning, error } = useToast();
  const { confirm } = useModal();
  const { session, departmentScope, hasPermission } = useAuth();

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDept, setSelectedDept] = useState<string>(departmentScope || 'Production');
  const [selectedDate, setSelectedDate] = useState<string>('2026-07-22');
  const [filterViolationOnly, setFilterViolationOnly] = useState<boolean>(false);

  // Live queries
  const employees = useLiveQuery(() => db.employees.toArray(), []) || [];
  const shiftRosters = useLiveQuery(() => db.shiftRosters.toArray(), []) || [];

  const departments = Array.from(new Set(employees.map(e => e.department))).filter(Boolean);

  // Filtered shift entries
  const filteredRosters = useMemo(() => {
    return shiftRosters.filter(item => {
      if (departmentScope && item.department !== departmentScope) return false;
      if (selectedDept !== 'ALL' && item.department !== selectedDept) return false;
      if (filterViolationOnly && !item.isRestViolation) return false;
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        const m1 = item.employeeId.toLowerCase().includes(q);
        const m2 = item.fullName.toLowerCase().includes(q);
        if (!m1 && !m2) return false;
      }
      return true;
    });
  }, [shiftRosters, departmentScope, selectedDept, filterViolationOnly, searchTerm]);

  // Violations count
  const totalViolations = useMemo(() => {
    return shiftRosters.filter(s => s.isRestViolation).length;
  }, [shiftRosters]);

  const canManageRoster = hasPermission('MANAGE_ROSTER') || hasPermission('MANAGE_DEPT_ROSTER');

  // Adjust shift action to fix violation (yêu cầu quyền MANAGE_ROSTER hoặc MANAGE_DEPT_ROSTER)
  const handleFixViolation = async (roster: IShiftRosterEntry, newShift: ShiftClassType) => {
    if (!canManageRoster) {
      error('Không đủ quyền', 'Bạn không có quyền điều chỉnh phân ca (MANAGE_ROSTER hoặc MANAGE_DEPT_ROSTER).');
      return;
    }
    let startTime = '06:00';
    let endTime = '14:00';
    let isViolating = false;

    if (newShift === 'SHIFT_2') {
      startTime = '14:00';
      endTime = '22:00';
      isViolating = false; // 22:00 to 14:00 next day is 16h rest >= 12h
    } else if (newShift === 'SHIFT_1') {
      startTime = '06:00';
      endTime = '14:00';
      // If previous was Shift 2 ending at 22:00 -> 8h rest -> violation
      if (roster.previousShiftEndTime === '22:00') {
        isViolating = true;
      }
    }

    await db.shiftRosters.update(roster.employeeId_date, {
      shiftCode: newShift,
      startTime,
      endTime,
      restHours: isViolating ? 8 : 16,
      isRestViolation: isViolating,
      isRestViolationFlag: isViolating ? 1 : 0,
      violationDetails: isViolating ? 'Nghỉ 8 giờ giữa Ca 2 (kết thúc 22h) và Ca 1 (bắt đầu 06h) < 12h' : undefined
    });

    if (isViolating) {
      warning('Vẫn còn vi phạm khoảng nghỉ', 'Ca 1 bắt đầu 06:00 sáng vẫn chỉ có 8 tiếng nghỉ ngơi sau Ca 2 kết thúc 22:00 đêm qua.');
    } else {
      success('Đã điều chỉnh ca thành công!', 'Khoảng nghỉ giữa 2 ca đã đạt chuẩn an toàn 16 tiếng (>= 12h).');
    }

    if (session) {
      logUserAction({
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        actionType: 'ASSIGN_SHIFT',
        targetEntity: `${roster.fullName} (${roster.employeeId})`,
        details: `Điều chỉnh phân ca từ ${roster.shiftCode} sang ${newShift} ngày ${roster.date} (${isViolating ? 'Còn vi phạm 8h' : 'Chuẩn an toàn 16h'})`
      }).catch(console.error);
    }
  };

  return (
    <div className="p-6 w-full space-y-6 flex-1 flex flex-col">
      {/* Top Banner */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <RotateCcw className="w-5 h-5 text-orange-500" />
            <span>Phân Ca & Kiểm Soát Vi Phạm Xoay Ca (Shift Roster & 12h Rest Rule)</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Quy định an toàn lao động Leggett & Platt: Người lao động phải có tối thiểu 12 giờ nghỉ ngơi liên tục giữa 2 ca làm việc. Hệ thống cảnh báo tự động khi xoay ca từ Ca 2 (22:00) sang Ca 1 (06:00) của ngày tiếp theo (chỉ nghỉ 8 tiếng).
          </p>
        </div>

        {/* Violations Summary Pill */}
        <div className={`px-4 py-2.5 rounded-xl border flex items-center gap-3 ${
          totalViolations > 0 
            ? 'bg-rose-50 border-rose-200 text-rose-800' 
            : 'bg-emerald-50 border-emerald-200 text-emerald-800'
        }`}>
          <ShieldAlert className={`w-5 h-5 ${totalViolations > 0 ? 'text-rose-600 animate-pulse' : 'text-emerald-600'}`} />
          <div className="text-xs">
            <div className="font-bold">{totalViolations} trường hợp vi phạm nghỉ &lt; 12h</div>
            <div className="text-[11px] opacity-80">Cần điều chỉnh ca trước khi ban hành</div>
          </div>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3 w-full md:w-auto flex-1 max-w-lg">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Tìm theo tên, mã NV..."
              className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-orange-500"
            />
          </div>

          <select
            value={selectedDept}
            onChange={(e) => setSelectedDept(e.target.value)}
            disabled={!!departmentScope}
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:border-orange-500 disabled:opacity-60"
            title={departmentScope ? `Đã khóa theo phạm vi quyền: ${departmentScope}` : 'Lọc theo bộ phận'}
          >
            <option value="ALL">Tất cả Bộ Phận</option>
            {departments.map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>

        {/* Toggle Violations Only */}
        <button
          onClick={() => setFilterViolationOnly(!filterViolationOnly)}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition border ${
            filterViolationOnly
              ? 'bg-rose-600 text-white border-rose-600 shadow-sm shadow-rose-200'
              : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
          }`}
        >
          <AlertTriangle className="w-4 h-4" />
          <span>Chỉ xem ca vi phạm (&lt; 12h)</span>
        </button>
      </div>

      {/* Roster Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex-1">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
              <tr>
                <th className="py-3 px-4">#</th>
                <th className="py-3 px-4">Mã NV & Họ Tên</th>
                <th className="py-3 px-4">Bộ Phận</th>
                <th className="py-3 px-4 text-center">Ngày Làm Việc</th>
                <th className="py-3 px-4 text-center">Ca Hôm Trước</th>
                <th className="py-3 px-4 text-center">Ca Hiện Tại</th>
                <th className="py-3 px-4 text-center">Khoảng Nghỉ Giữa 2 Ca</th>
                <th className="py-3 px-4 text-center">Cảnh Báo An Toàn</th>
                <th className="py-3 px-4 text-right">Điều Chỉnh Ca</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRosters.map((roster, idx) => {
                return (
                  <tr
                    key={roster.employeeId_date}
                    className={`transition ${
                      roster.isRestViolation ? 'bg-rose-50/40 hover:bg-rose-50/70' : 'hover:bg-slate-50/80'
                    }`}
                  >
                    <td className="py-3 px-4 text-slate-400 font-semibold">{idx + 1}</td>
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-900">{roster.fullName}</div>
                      <div className="text-[11px] text-slate-400 font-mono">{roster.employeeId}</div>
                    </td>
                    <td className="py-3 px-4 font-semibold text-slate-700">{roster.department}</td>
                    <td className="py-3 px-4 text-center font-bold text-slate-800">
                      {roster.date}
                    </td>
                    <td className="py-3 px-4 text-center">
                      {roster.previousShiftEndTime === '22:00' ? (
                        <span className="px-2 py-0.5 rounded-md bg-pink-50 text-pink-700 font-bold border border-pink-200 text-xs">
                          Ca 2 (14h - 22h)
                        </span>
                      ) : roster.previousShiftEndTime === '14:00' ? (
                        <span className="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 font-bold border border-indigo-200 text-xs">
                          Ca 1 (06h - 14h)
                        </span>
                      ) : roster.previousShiftEndTime === '16:00' || roster.previousShiftEndTime === '16:30' ? (
                        <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 font-bold border border-emerald-200 text-xs">
                          HC ({roster.previousShiftEndTime === '16:00' ? '07h30 - 16h00' : '07h30 - 16h30'})
                        </span>
                      ) : roster.previousShiftEndTime ? (
                        <span className="px-2 py-0.5 rounded-md bg-slate-50 text-slate-700 font-semibold border border-slate-200 text-xs">
                          Hết ca lúc {roster.previousShiftEndTime}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-xs">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center">
                      {roster.shiftCode === 'SHIFT_1' ? (
                        <span className="px-2.5 py-1 rounded-md bg-indigo-50 text-indigo-700 font-bold border border-indigo-200">
                          Ca 1 (06h - 14h)
                        </span>
                      ) : (
                        <span className="px-2.5 py-1 rounded-md bg-pink-50 text-pink-700 font-bold border border-pink-200">
                          Ca 2 (14h - 22h)
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center font-extrabold">
                      <span className={`px-2.5 py-1 rounded-full text-[11px] ${
                        roster.isRestViolation
                          ? 'bg-rose-100 text-rose-700 border border-rose-300'
                          : 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                      }`}>
                        {roster.restHours} giờ nghỉ
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      {roster.isRestViolation ? (
                        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-600 text-white font-bold text-[11px] shadow-sm animate-pulse">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>VI PHẠM &lt; 12H NGHỈ</span>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[11px]">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                          <span>Đạt chuẩn</span>
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {roster.isRestViolation && canManageRoster && (
                        <button
                          onClick={() => handleFixViolation(roster, 'SHIFT_2')}
                          className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-lg transition shadow-sm"
                          title="Chuyển sang Ca 2 để đảm bảo 16h nghỉ ngơi"
                        >
                          Chuyển sang Ca 2
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
