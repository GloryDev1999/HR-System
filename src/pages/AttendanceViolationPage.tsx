import React, { useState, useMemo } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Filter, Search, FileCheck2, UserCheck, LogOut, LogIn, ShieldAlert, CalendarDays } from 'lucide-react';
import { useLiveTable, upsertOne } from '../lib/tables';
import type { IEmployee, IShiftRosterEntry, IDailyTimesheetCell, AttendanceStatusCode } from '../types';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';

type ViolationFilter = 'ALL' | 'LA' | 'ED' | 'MCO' | 'MCI';

export const AttendanceViolationPage: React.FC = () => {
  const { success, warning, error } = useToast();
  const { departmentScope, hasPermission } = useAuth();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDept, setSelectedDept] = useState<string>('ALL');
  const [filterCode, setFilterCode] = useState<ViolationFilter>('ALL');
  const [onlyPending, setOnlyPending] = useState<boolean>(false);

  const employees = useLiveTable<IEmployee>('employees');
  const timesheets = useLiveTable<IDailyTimesheetCell>('dailyTimesheets');
  const shiftRosters = useLiveTable<IShiftRosterEntry>('shiftRosters');

  const departments = Array.from(new Set(employees.map(e => e.department))).filter(Boolean);

  // Map shift roster for ca dự kiến
  const shiftMap = useMemo(() => {
    const m = new Map<string, string>();
    shiftRosters.forEach(r => m.set(r.employeeId_date, `${r.shiftCode} (${r.startTime}-${r.endTime})`));
    return m;
  }, [shiftRosters]);

  const empMap = useMemo(() => {
    const m = new Map<string, any>();
    employees.forEach(e => m.set(e.employeeId, e));
    return m;
  }, [employees]);

  // Filter violations: LA, ED, MCO, MCI (+ nếu onlyPending thì chỉ isViolation true)
  const violations = useMemo(() => {
    let list = timesheets.filter(ts => {
      const code = (ts.statusCode || '').trim();
      return code === 'LA' || code === 'ED' || code === 'MCO' || code === 'MCI';
    });
    // Dept scope
    if (departmentScope) {
      list = list.filter(ts => {
        const emp = empMap.get(ts.employeeId);
        return emp && emp.department === departmentScope;
      });
    }
    if (selectedDept !== 'ALL') {
      list = list.filter(ts => {
        const emp = empMap.get(ts.employeeId);
        return emp && emp.department === selectedDept;
      });
    }
    if (filterCode !== 'ALL') {
      list = list.filter(ts => ts.statusCode === filterCode);
    }
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      list = list.filter(ts => {
        const emp = empMap.get(ts.employeeId);
        const name = emp?.fullName?.toLowerCase() || '';
        return ts.employeeId.toLowerCase().includes(q) || name.includes(q) || ts.date.includes(q);
      });
    }
    if (onlyPending) {
      // Chờ duyệt: là vi phạm chưa được xác thực thủ công (isViolation !== false)
      list = list.filter(ts => ts.isViolation !== false);
    }
    // Sort by date desc
    list.sort((a, b) => b.date.localeCompare(a.date));
    return list;
  }, [timesheets, empMap, departmentScope, selectedDept, filterCode, searchTerm, onlyPending]);

  const stats = useMemo(() => {
    const la = timesheets.filter(t => t.statusCode === 'LA').length;
    const ed = timesheets.filter(t => t.statusCode === 'ED').length;
    const mco = timesheets.filter(t => t.statusCode === 'MCO').length;
    const mci = timesheets.filter(t => t.statusCode === 'MCI').length;
    const pending = timesheets.filter(t => t.isViolation !== false && (t.statusCode === 'LA' || t.statusCode === 'ED' || t.statusCode === 'MCO' || t.statusCode === 'MCI')).length;
    return { la, ed, mco, mci, pending, total: la+ed+mco+mci };
  }, [timesheets]);

  const handleApprove = async (cell: IDailyTimesheetCell, newCode: AttendanceStatusCode) => {
    if (!hasPermission('MANAGE_TIMESHEET') && !hasPermission('MANAGE_LEAVE')) {
      warning('Không đủ quyền', 'Bạn cần quyền MANAGE_TIMESHEET hoặc MANAGE_LEAVE để duyệt.');
      return;
    }
    const updated: IDailyTimesheetCell = {
      ...cell,
      statusCode: newCode,
      isViolation: false,
      isViolationFlag: 0,
      violationNote: newCode === 'W' ? `Đã xác thực thủ công - duyệt ${cell.statusCode} → W (${new Date().toLocaleDateString('vi-VN')})` : `Đã duyệt ${cell.statusCode} → ${newCode}`,
    };
    // Nếu duyệt về W thì giữ nguyên checkIn/checkOut, clear lateMinutes nếu cần? Giữ lại để trace.
    await upsertOne('dailyTimesheets', updated);
    success('Đã xác thực thủ công', `Đã chuyển ${cell.employeeId} ngày ${cell.date} từ ${cell.statusCode} → ${newCode}`);
  };

  const handleClearViolation = async (cell: IDailyTimesheetCell) => {
    // Xác nhận đã nhận giấy tờ và duyệt công đủ (W)
    await handleApprove(cell, 'W');
  };

  const getStatusBadge = (code: string, isViolation?: boolean) => {
    if (code === 'LA') return <span className="px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 border border-orange-200 text-[11px] font-bold">LA - Đi trễ</span>;
    if (code === 'ED') return <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200 text-[11px] font-bold">ED - Về sớm</span>;
    if (code === 'MCO') return <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200 text-[11px] font-bold">MCO - Không ra</span>;
    if (code === 'MCI') return <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 border border-rose-200 text-[11px] font-bold">MCI - Không vào</span>;
    return <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 text-[11px] font-bold">{code}</span>;
  };

  return (
    <div className="p-6 w-full space-y-6 flex-1 flex flex-col font-sans">
      {/* Header */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-orange-500" />
            <span>Theo dõi chi tiết Đi trễ / Về sớm / Không chấm thẻ</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1 max-w-[860px] leading-relaxed">
            Tham chiếu từ dữ liệu quẹt thẻ máy chấm công theo ca đã sắp xếp (Ca 1: 06:00-14:00, Ca 2: 14:00-22:00, HC: 07:30-16:00 T2-T7, HC VP: 07:30-16:00 T2-T6). 
            <b>LA</b> = Đi trễ từ 2' - dưới 60', <b>ED</b> = Về sớm từ 2' - dưới 60' (có ghi chú số phút). Đi trễ/về sớm từ 60' trở lên tính là <b>OFF</b> và tự động chuyển sang menu <i>Chờ bù phép</i>.
            <b>MCO</b> = Không chấm ra (chỉ có giờ vào), <b>MCI</b> = Không chấm vào (chỉ có giờ ra). Toàn bộ cần được HR duyệt hoặc xác thực thủ công sau khi đối chiếu giấy tờ.
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold">
            <span className="px-2.5 py-1 rounded-full bg-slate-900 text-white">Tổng {stats.total}</span>
            <span className="px-2.5 py-1 rounded-full bg-orange-100 text-orange-700 border border-orange-200">LA: {stats.la}</span>
            <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 border border-amber-200">ED: {stats.ed}</span>
            <span className="px-2.5 py-1 rounded-full bg-rose-100 text-rose-700 border border-rose-200">MCO: {stats.mco}</span>
            <span className="px-2.5 py-1 rounded-full bg-rose-100 text-rose-700 border border-rose-200">MCI: {stats.mci}</span>
            {stats.pending > 0 && <span className="px-2.5 py-1 rounded-full bg-rose-600 text-white animate-pulse">Chờ duyệt: {stats.pending}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500 hidden lg:inline">Hiển thị {violations.length} bản ghi</span>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col gap-3">
        <div className="flex flex-col lg:flex-row gap-3 items-start lg:items-center justify-between">
          <div className="flex flex-wrap items-center gap-3 flex-1">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Tìm mã NV, tên, ngày YYYY-MM-DD..."
                className="pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs w-64 focus:outline-none focus:border-orange-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-slate-500" />
              <select
                value={selectedDept}
                onChange={(e) => setSelectedDept(e.target.value)}
                disabled={!!departmentScope}
                className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:border-orange-500 disabled:opacity-60"
              >
                <option value="ALL">Tất cả Bộ phận</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <select
              value={filterCode}
              onChange={(e) => setFilterCode(e.target.value as ViolationFilter)}
              className="px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold focus:outline-none focus:border-orange-500"
            >
              <option value="ALL">Tất cả mã vi phạm</option>
              <option value="LA">LA - Đi trễ</option>
              <option value="ED">ED - Về sớm</option>
              <option value="MCO">MCO - Không chấm ra</option>
              <option value="MCI">MCI - Không chấm vào</option>
            </select>
            <button
              onClick={() => setOnlyPending(!onlyPending)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border transition ${onlyPending ? 'bg-rose-600 text-white border-rose-600 shadow' : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'}`}
            >
              <AlertTriangle className="w-4 h-4" />
              Chỉ chờ duyệt (chưa xác thực)
            </button>
          </div>
        </div>
        <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 leading-relaxed">
          Quy định: Đi trễ từ 2' - dưới 60' ghi <b>LA</b>. Về sớm từ 2' - dưới 60' ghi <b>ED</b>. Trễ hoặc sớm từ 60' trở lên tính <b>OFF</b> và chuyển sang <i>Chờ bù phép</i>. Có vào nhưng không ra ghi <b>MCI</b>. Có ra nhưng không vào ghi <b>MCO</b>. HR bấm "Duyệt W" khi nhân viên có giấy giải trình hợp lệ để xác thực đủ công.
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex-1">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
              <tr>
                <th className="py-3 px-3 w-10">#</th>
                <th className="py-3 px-3">Mã NV & Họ tên</th>
                <th className="py-3 px-3">Bộ phận</th>
                <th className="py-3 px-3 text-center">Ngày</th>
                <th className="py-3 px-3 text-center">Ca dự kiến</th>
                <th className="py-3 px-3 text-center">Giờ vào - ra</th>
                <th className="py-3 px-3 text-center">Mã vi phạm</th>
                <th className="py-3 px-3">Ghi chú</th>
                <th className="py-3 px-3 text-center">Trễ/Sớm</th>
                <th className="py-3 px-3 text-center">Trạng thái duyệt</th>
                <th className="py-3 px-3 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {violations.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-10 text-center text-slate-400">
                    <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-500 mb-2" />
                    <p className="font-semibold text-slate-600">Không có vi phạm nào khớp bộ lọc</p>
                    <p className="text-[11px] text-slate-400 mt-1">LA (2'-&lt;60'), ED (2'-&lt;60'), MCO, MCI được ghi khi quẹt thiếu hoặc lệch ca; cần được HR duyệt</p>
                  </td>
                </tr>
              )}
              {violations.map((cell, idx) => {
                const emp = empMap.get(cell.employeeId);
                const dept = emp?.department || '—';
                const fullName = emp?.fullName || cell.employeeId;
                const shiftLabel = shiftMap.get(cell.employeeId_date) || (emp?.shiftClassId ? `${emp.shiftClassId}` : 'HC 07:30-16:00');
                const isPendingApproval = cell.isViolation !== false;
                return (
                  <tr key={cell.employeeId_date} className={`hover:bg-slate-50/80 transition ${isPendingApproval ? 'bg-amber-50/20' : ''}`}>
                    <td className="py-2.5 px-3 text-slate-400 font-semibold">{idx + 1}</td>
                    <td className="py-2.5 px-3">
                      <div className="font-bold text-slate-900">{cell.employeeId}</div>
                      <div className="text-[11px] text-slate-600">{fullName}</div>
                    </td>
                    <td className="py-2.5 px-3">
                      <span className="px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-[11px] font-semibold">{dept}</span>
                    </td>
                    <td className="py-2.5 px-3 text-center font-mono font-bold">
                      {cell.date}
                      <div className="text-[10px] text-slate-400">{cell.dayIndex ? `Ngày ${cell.dayIndex}` : ''}</div>
                    </td>
                    <td className="py-2.5 px-3 text-center text-[11px] font-semibold text-slate-700">{shiftLabel}</td>
                    <td className="py-2.5 px-3 text-center font-mono text-[11px]">
                      <span className={cell.statusCode === 'MCI' ? 'text-rose-600 font-bold' : 'text-slate-700'}>{cell.checkIn || '--:--'}</span>
                      <span className="mx-1 text-slate-400">→</span>
                      <span className={cell.statusCode === 'MCO' ? 'text-rose-600 font-bold' : 'text-slate-700'}>{cell.checkOut || '--:--'}</span>
                    </td>
                    <td className="py-2.5 px-3 text-center">{getStatusBadge(cell.statusCode || '', cell.isViolation)}</td>
                    <td className="py-2.5 px-3 max-w-[260px]">
                      <div className="text-[11px] text-slate-600 leading-relaxed truncate" title={cell.violationNote}>{cell.violationNote || '—'}</div>
                    </td>
                    <td className="py-2.5 px-3 text-center font-bold">
                      {cell.lateMinutes ? <span className="text-orange-600">{cell.lateMinutes}p trễ</span> : cell.earlyMinutes ? <span className="text-amber-600">{cell.earlyMinutes}p sớm</span> : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="py-2.5 px-3 text-center">
                      {isPendingApproval ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200 text-[11px] font-bold">
                          <Clock className="w-3 h-3" /> Chờ duyệt
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200 text-[11px] font-bold">
                          <CheckCircle2 className="w-3 h-3" /> Đã xác thực
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleClearViolation(cell)}
                          className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[11px] font-bold flex items-center gap-1 shadow-sm"
                          title="Đã nhận giấy tờ, duyệt thành W (đủ công)"
                        >
                          <FileCheck2 className="w-3.5 h-3.5" /> Duyệt W
                        </button>
                        <div className="relative group">
                          <button className="px-2 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[11px] font-semibold">
                            Khác ▾
                          </button>
                          <div className="absolute right-0 mt-1 w-40 bg-white rounded-xl shadow-xl border border-slate-200 py-1 hidden group-hover:block z-30">
                            <button onClick={() => handleApprove(cell, 'AL')} className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50">→ AL (Phép năm)</button>
                            <button onClick={() => handleApprove(cell, 'PL')} className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50">→ PL (Tang/Cưới)</button>
                            <button onClick={() => handleApprove(cell, 'UL')} className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50">→ UL (Không lương)</button>
                            <button onClick={() => handleApprove(cell, 'W')} className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50">→ W (Đủ công)</button>
                          </div>
                        </div>
                      </div>
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
