import React, { useState, useMemo } from 'react';
import { 
  TrendingUp, 
  Plus, 
  Trash2, 
  CalendarRange, 
  Clock3, 
  CheckCircle2, 
  Layers,
  Percent,
  Sliders,
  Users
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { IProductionLine, IProductivityQualityRate } from '../types';
import { generateCalendarDays, CalendarDay } from '../services/calendar-utils';
import { formatPayPeriodLabel } from '../services/pay-period';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';
import { useAuth } from '../context/AuthContext';
import { logUserAction } from '../services/audit-log-service';
import { stampRateFieldMeta, stampSyncMeta } from '../services/json-sync-service';

export const ProductivityQualityPage: React.FC = () => {
  const { success, warning, error } = useToast();
  const { confirm } = useModal();
  const { session, currentRole, hasPermission } = useAuth();
  
  // Phân quyền độc lập theo yêu cầu:
  // - Han (Prd-Admin): chỉ được sửa Năng Suất (canEditNS=true, canEditCL=false)
  // - Nguyet Anh (QC-Admin): chỉ được sửa Chất Lượng (canEditCL=true, canEditNS=false)
  // - Master Host / HR Client / Technical (Kieu, Hoa, Glory): toàn quyền cả 2 và quản lý Line
  const isMasterUser = currentRole === 'AD System' || currentRole === 'HR Manager' || currentRole === 'HR Admin';
  const canEditNS = hasPermission('ALL_ACCESS') || hasPermission('EDIT_PRODUCTIVITY_RATE');
  const canEditCL = hasPermission('ALL_ACCESS') || hasPermission('EDIT_QUALITY_RATE');
  const canManageLines = isMasterUser;
  const canManage = isMasterUser;

  const [cycleMode, setCycleMode] = useState<'SEASONAL' | 'OFFICIAL'>('OFFICIAL');
  const [selectedMonth, setSelectedMonth] = useState<number>(() => {
    const saved = localStorage.getItem('smarthr_selected_month');
    return saved ? parseInt(saved, 10) : 8;
  });
  const [selectedYear, setSelectedYear] = useState<number>(() => {
    const saved = localStorage.getItem('smarthr_selected_year');
    return saved ? parseInt(saved, 10) : 2026;
  });
  const [selectedLineFilter, setSelectedLineFilter] = useState<string>('ALL');

  // Modal states
  const [showAddLineModal, setShowAddLineModal] = useState(false);
  const [newLineId, setNewLineId] = useState('');
  const [newLineName, setNewLineName] = useState('');
  const [newLineDesc, setNewLineDesc] = useState('');

  // Queries
  const lines = useLiveQuery(() => db.productionLines.toArray(), []) || [];
  const rates = useLiveQuery(
    async () => {
      if (cycleMode === 'OFFICIAL') {
        const prevMonth = selectedMonth === 1 ? 12 : selectedMonth - 1;
        const prevYear = selectedMonth === 1 ? selectedYear - 1 : selectedYear;
        const [rCurr, rPrev] = await Promise.all([
          db.productivityQualityRates.where('month').equals(selectedMonth).filter(r => r.year === selectedYear).toArray(),
          db.productivityQualityRates.where('month').equals(prevMonth).filter(r => r.year === prevYear).toArray()
        ]);
        return [...rPrev, ...rCurr];
      }
      return db.productivityQualityRates.where('month').equals(selectedMonth).filter(r => r.year === selectedYear).toArray();
    },
    [selectedMonth, selectedYear, cycleMode]
  ) || [];
  const employees = useLiveQuery(() => db.employees.toArray(), []) || [];

  // Rates map: `${lineId}_${dateStr}` -> IProductivityQualityRate
  const rateMap = useMemo(() => {
    const map = new Map<string, IProductivityQualityRate>();
    rates.forEach(r => map.set(r.lineId_date, r));
    return map;
  }, [rates]);

  // Calendar days
  const calendarDays = useMemo(
    () => generateCalendarDays(selectedMonth, selectedYear, cycleMode),
    [selectedMonth, selectedYear, cycleMode]
  );
  const payLabel = formatPayPeriodLabel(selectedMonth, selectedYear, cycleMode);

  // Filtered lines
  const filteredLines = useMemo(() => {
    if (selectedLineFilter === 'ALL') return lines;
    return lines.filter(l => l.id === selectedLineFilter);
  }, [lines, selectedLineFilter]);

  // Save single rate cell
  const handleSaveRate = async (lineId: string, dateStr: string, day: CalendarDay, type: 'NS' | 'CL', val: number) => {
    if (type === 'NS' && !canEditNS) {
      error('Không đủ quyền', 'Tài khoản của bạn không có quyền chỉnh sửa Tỷ Lệ Năng Suất (chỉ dành cho Prd-Admin hoặc Quản trị viên).');
      return;
    }
    if (type === 'CL' && !canEditCL) {
      error('Không đủ quyền', 'Tài khoản của bạn không có quyền chỉnh sửa Tỷ Lệ Chất Lượng (chỉ dành cho QC-Admin hoặc Quản trị viên).');
      return;
    }

    const key = `${lineId}_${dateStr}`;
    const existing = rateMap.get(key);
    const at = new Date().toISOString();
    const by = (session?.username || 'unknown').toLowerCase();
    const newRate: IProductivityQualityRate = {
      lineId_date: key,
      lineId,
      date: dateStr,
      month: day.monthNum,
      year: day.yearNum,
      productivityRate: type === 'NS' ? val : (existing?.productivityRate ?? 100),
      qualityRate: type === 'CL' ? val : (existing?.qualityRate ?? 98),
      updatedAt: at,
      updatedBy: by,
    };
    // Truy vết field-level để merge JSON không mất dữ liệu han (NS) / nguyetanh (CL)
    stampSyncMeta(newRate as any, by, at);
    stampRateFieldMeta(newRate as any, type, by, at);
    if (existing) {
      // Giữ lại stamp field đối diện để không mất mốc của người kia
      const keepKey = type === 'NS' ? '_syncCL' : '_syncNS';
      if ((existing as any)[keepKey] && !(newRate as any)[keepKey]) (newRate as any)[keepKey] = (existing as any)[keepKey];
    }

    try {
      await db.productivityQualityRates.put(newRate);

      if (session) {
        logUserAction({
          username: session.username,
          displayName: session.displayName,
          role: session.role,
          actionType: type === 'NS' ? 'UPDATE_RATE_NS' : 'UPDATE_RATE_CL',
          targetEntity: `${lineId} (${dateStr})`,
          details: `Cập nhật ${type === 'NS' ? 'Tỷ lệ Năng Suất' : 'Tỷ lệ Chất Lượng'} = ${val}% cho chuyền ${lineId} ngày ${dateStr}`
        }).catch(console.error);
      }
    } catch (e: any) {
      error('Lỗi lưu tỷ lệ', e.message);
    }
  };

  // Create new line
  const handleCreateLine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage) {
      error('Không đủ quyền', 'Bạn không có quyền tạo chuyền sản xuất.');
      return;
    }
    if (!newLineName.trim()) {
      warning('Thiếu thông tin', 'Vui lòng nhập tên Chuyền/Line sản xuất.');
      return;
    }
    const id = newLineId.trim() || `line_${Date.now()}`;
    try {
      await db.productionLines.put({
        id,
        name: newLineName.trim(),
        description: newLineDesc.trim() || undefined,
        createdAt: new Date().toISOString()
      });
      success('Thêm Line thành công', `Đã tạo ${newLineName.trim()}`);
      setNewLineId('');
      setNewLineName('');
      setNewLineDesc('');
      setShowAddLineModal(false);
    } catch (e: any) {
      error('Lỗi khi thêm line', e.message);
    }
  };

  // Delete line
  const handleDeleteLine = async (line: IProductionLine) => {
    if (!canManage) {
      error('Không đủ quyền', 'Bạn không có quyền xóa chuyền sản xuất.');
      return;
    }
    const ok = await confirm({
      title: 'Xóa Line sản xuất',
      message: `Bạn có chắc chắn muốn xóa "${line.name}"? Dữ liệu tỷ lệ đã lưu sẽ không thể hoàn tác.`,
      confirmText: 'Xóa Line',
      cancelText: 'Hủy bỏ',
      type: 'danger'
    });
    if (ok) {
      await db.productionLines.delete(line.id);
      await db.productivityQualityRates.where('lineId').equals(line.id).delete();
      success('Đã xóa Line', `Line ${line.name} đã được xóa.`);
    }
  };

  return (
    <div className="p-5 w-full space-y-5 flex-1 flex flex-col font-sans">
      {/* Top Banner */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-xl bg-orange-50 text-orange-600 border border-orange-200">
              <TrendingUp className="w-5 h-5" />
            </span>
            <h2 className="text-lg font-bold text-slate-900">
              Tỷ Lệ Đạt Năng Suất & Chất Lượng Theo Chuyền
            </h2>
            <span className="px-2.5 py-1 bg-slate-900 text-white rounded-lg text-xs font-black">
              Tháng {String(selectedMonth).padStart(2, '0')}/{selectedYear}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl">
            Cập nhật tỷ lệ % Năng suất & % Chất lượng hàng ngày cho từng chuyền sản xuất (Line Rivet 1, Line Rivet 2...). Dữ liệu được tính toán cho nhóm công nhân hưởng năng suất theo Line.
          </p>

          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <button
              onClick={() => setCycleMode('OFFICIAL')}
              className={`px-3 py-1.5 rounded-xl border font-bold flex items-center gap-1.5 transition ${
                cycleMode === 'OFFICIAL' ? 'bg-slate-900 text-white border-slate-900 shadow-sm' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <CalendarRange className="w-3.5 h-3.5" />
              <span>Chính thức (21-20): {formatPayPeriodLabel(selectedMonth, selectedYear, 'OFFICIAL')}</span>
            </button>
            <button
              onClick={() => setCycleMode('SEASONAL')}
              className={`px-3 py-1.5 rounded-xl border font-bold flex items-center gap-1.5 transition ${
                cycleMode === 'SEASONAL' ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              <Clock3 className="w-3.5 h-3.5" />
              <span>Thời vụ (1-31): {formatPayPeriodLabel(selectedMonth, selectedYear, 'SEASONAL')}</span>
            </button>
          </div>
        </div>

        {/* Action Buttons - Chỉ 3 user lớn (Kieu, Hoa, Glory) được hiển thị nút Thêm Line Sản Xuất */}
        {isMasterUser && (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setShowAddLineModal(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-orange-500 to-rose-500 hover:from-orange-600 hover:to-rose-600 text-white text-xs font-bold rounded-xl shadow-md shadow-orange-200 transition"
            >
              <Plus className="w-4 h-4" />
              <span>Thêm Line Sản Xuất</span>
            </button>
          </div>
        )}
      </div>

      {/* Filter Bar */}
      <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2 flex-wrap">
          <label className="font-semibold text-slate-700 flex items-center gap-1">
            <Layers className="w-3.5 h-3.5 text-slate-400" />
            <span>Lọc Chuyền:</span>
          </label>
          <select
            value={selectedLineFilter}
            onChange={(e) => setSelectedLineFilter(e.target.value)}
            className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium focus:outline-none focus:border-orange-500"
          >
            <option value="ALL">Tất cả Line sản xuất ({lines.length})</option>
            {lines.map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>

          <label className="ml-2 font-semibold text-slate-700">Kỳ tháng:</label>
          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(parseInt(e.target.value))}
            className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold"
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
              <option key={m} value={m}>Tháng {m}</option>
            ))}
          </select>
          <select
            value={selectedYear}
            onChange={(e) => setSelectedYear(parseInt(e.target.value))}
            className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold"
          >
            {[2025, 2026, 2027].map(y => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-emerald-500"></span> NS &ge; 100% / CL &ge; 98%</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-amber-500"></span> Cảnh báo</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-rose-500"></span> Không đạt</span>
        </div>
      </div>

      {/* Main List of Line Matrices */}
      <div className="space-y-6">
        {filteredLines.map((line) => {
          // Calculate monthly averages for this line
          let sumNS = 0;
          let countNS = 0;
          let sumCL = 0;
          let countCL = 0;

          calendarDays.forEach(day => {
            const key = `${line.id}_${day.dateStr}`;
            const r = rateMap.get(key);
            if (r) {
              if (r.productivityRate != null) { sumNS += r.productivityRate; countNS++; }
              if (r.qualityRate != null) { sumCL += r.qualityRate; countCL++; }
            }
          });

          const avgNS = countNS > 0 ? Math.round(sumNS / countNS) : 100;
          const avgCL = countCL > 0 ? Math.round(sumCL / countCL) : 98;
          const assignedEmps = employees.filter(e => e.productionLine === line.id);

          return (
            <div key={line.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              {/* Line Header */}
              <div className="p-4 bg-gradient-to-r from-slate-50 via-white to-orange-50/20 border-b border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-orange-500 text-white font-black flex items-center justify-center text-sm shadow-md shadow-orange-200">
                    {line.name.replace(/[^0-9]/g, '') || 'L'}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-sm text-slate-900">{line.name}</h3>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-50 text-purple-700 border border-purple-200">
                        {line.id}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-700 flex items-center gap-1">
                        <Users className="w-3 h-3 text-slate-500" />
                        <span>{assignedEmps.length} nhân viên gán</span>
                      </span>
                    </div>
                    {line.description && (
                      <p className="text-[11px] text-slate-500 mt-0.5">{line.description}</p>
                    )}
                  </div>
                </div>

                {/* KPI Summary for this Line */}
                <div className="flex items-center gap-4 text-xs">
                  <div className="px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-center">
                    <div className="text-[10px] text-emerald-600 font-semibold uppercase tracking-wider">TB % Năng Suất</div>
                    <div className="text-sm font-black text-emerald-800">{avgNS}%</div>
                  </div>
                  <div className="px-3 py-1.5 rounded-xl bg-blue-50 border border-blue-200 text-center">
                    <div className="text-[10px] text-blue-600 font-semibold uppercase tracking-wider">TB % Chất Lượng</div>
                    <div className="text-sm font-black text-blue-800">{avgCL}%</div>
                  </div>

                  {canManage && line.id !== 'line_rivet_1' && line.id !== 'line_rivet_2' && (
                    <button
                      onClick={() => handleDeleteLine(line)}
                      className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition"
                      title="Xóa Line sản xuất này"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Day-by-day Matrix */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="bg-slate-900 text-white font-bold">
                    <tr>
                      <th className="py-2.5 px-3 bg-slate-900 sticky left-0 z-20 min-w-[130px] border-r border-slate-800 whitespace-nowrap">
                        Chỉ số đánh giá
                      </th>
                      {calendarDays.map((day) => (
                        <th
                          key={day.dayIndex}
                          className={`py-1.5 px-1 text-center min-w-[44px] border-r border-slate-800 select-none ${
                            day.isSunday ? 'bg-amber-950/80 text-amber-200' : (day.isSaturday ? 'bg-slate-800 text-slate-300' : 'bg-slate-900')
                          }`}
                        >
                          <div className="text-[10px] opacity-75">{day.dayVi}</div>
                          <div className="text-xs font-bold">{day.dayNum}</div>
                        </th>
                      ))}
                      <th className="py-2.5 px-3 bg-indigo-950 text-indigo-200 text-center min-w-[70px] whitespace-nowrap">
                        TB Tháng
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white font-medium">
                    {/* Row 1: % Năng suất */}
                    <tr className="hover:bg-slate-50/60 transition">
                      <td className="py-2.5 px-3 bg-slate-50 font-bold text-slate-800 sticky left-0 z-10 border-r border-slate-200 flex items-center gap-1.5 whitespace-nowrap">
                        <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                        <span>% Năng Suất</span>
                      </td>
                      {calendarDays.map((day) => {
                        const key = `${line.id}_${day.dateStr}`;
                        const r = rateMap.get(key);
                        const val = r?.productivityRate ?? 100;
                        const isHigh = val >= 100;
                        const isMid = val >= 80 && val < 100;

                        return (
                          <td
                            key={day.dayIndex}
                            className={`p-1 text-center border-r border-slate-100 ${
                              day.isSunday ? 'bg-amber-50/20' : (day.isSaturday ? 'bg-slate-50/30' : '')
                            }`}
                          >
                            <input
                              type="number"
                              min={0}
                              max={200}
                              defaultValue={val}
                              disabled={!canEditNS}
                              key={`${key}_ns_${val}`}
                              onBlur={(e) => {
                                const newV = parseFloat(e.target.value) || 0;
                                if (newV !== val) handleSaveRate(line.id, day.dateStr, day, 'NS', newV);
                              }}
                              className={`w-10 px-1 py-1 text-center font-bold text-xs rounded-lg border focus:ring-2 focus:ring-orange-500/20 focus:outline-none transition ${
                                !canEditNS ? 'opacity-40 cursor-not-allowed bg-slate-100 border-slate-300 ' : ''
                              }${
                                isHigh
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : isMid
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : 'bg-rose-50 text-rose-800 border-rose-200'
                              }`}
                              title={canEditNS ? `Ngày ${day.dayNum}/${day.monthNum}: ${val}% Năng suất` : `Tài khoản của bạn không có quyền sửa % Năng suất (Chỉ xem)`}
                            />
                          </td>
                        );
                      })}
                      <td className="py-2.5 px-3 text-center font-black text-emerald-700 bg-emerald-50/30">
                        {avgNS}%
                      </td>
                    </tr>

                    {/* Row 2: % Chất lượng */}
                    <tr className="hover:bg-slate-50/60 transition">
                      <td className="py-2.5 px-3 bg-slate-50 font-bold text-slate-800 sticky left-0 z-10 border-r border-slate-200 flex items-center gap-1.5 whitespace-nowrap">
                        <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                        <span>% Chất Lượng</span>
                      </td>
                      {calendarDays.map((day) => {
                        const key = `${line.id}_${day.dateStr}`;
                        const r = rateMap.get(key);
                        const val = r?.qualityRate ?? 98;
                        const isHigh = val >= 98;
                        const isMid = val >= 95 && val < 98;

                        return (
                          <td
                            key={day.dayIndex}
                            className={`p-1 text-center border-r border-slate-100 ${
                              day.isSunday ? 'bg-amber-50/20' : (day.isSaturday ? 'bg-slate-50/30' : '')
                            }`}
                          >
                            <input
                              type="number"
                              min={0}
                              max={100}
                              defaultValue={val}
                              disabled={!canEditCL}
                              key={`${key}_cl_${val}`}
                              onBlur={(e) => {
                                const newV = parseFloat(e.target.value) || 0;
                                if (newV !== val) handleSaveRate(line.id, day.dateStr, day, 'CL', newV);
                              }}
                              className={`w-10 px-1 py-1 text-center font-bold text-xs rounded-lg border focus:ring-2 focus:ring-blue-500/20 focus:outline-none transition ${
                                !canEditCL ? 'opacity-40 cursor-not-allowed bg-slate-100 border-slate-300 ' : ''
                              }${
                                isHigh
                                  ? 'bg-blue-50 text-blue-800 border-blue-200'
                                  : isMid
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : 'bg-rose-50 text-rose-800 border-rose-200'
                              }`}
                              title={canEditCL ? `Ngày ${day.dayNum}/${day.monthNum}: ${val}% Chất lượng` : `Tài khoản của bạn không có quyền sửa % Chất lượng (Chỉ xem)`}
                            />
                          </td>
                        );
                      })}
                      <td className="py-2.5 px-3 text-center font-black text-blue-700 bg-blue-50/30">
                        {avgCL}%
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}

        {filteredLines.length === 0 && (
          <div className="p-12 text-center bg-white rounded-2xl border border-slate-200 shadow-sm text-xs text-slate-500">
            Không tìm thấy chuyền sản xuất nào. Nhấn "+ Thêm Line Sản Xuất" để tạo mới.
          </div>
        )}
      </div>

      {/* Modal: Add New Line */}
      {showAddLineModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100 space-y-4 animate-in fade-in zoom-in duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="font-bold text-base text-slate-900 flex items-center gap-2">
                <Plus className="w-5 h-5 text-orange-500" />
                <span>Thêm Line / Chuyền Sản Xuất Mới</span>
              </h3>
              <button onClick={() => setShowAddLineModal(false)} className="text-slate-400 hover:text-slate-600 text-lg font-bold">✕</button>
            </div>

            <form onSubmit={handleCreateLine} className="space-y-4 text-xs">
              <div>
                <label className="block font-bold text-slate-700 mb-1">Mã Line (ID định danh):</label>
                <input
                  type="text"
                  placeholder="line_rivet_3..."
                  value={newLineId}
                  onChange={(e) => setNewLineId(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-mono text-xs focus:outline-none focus:border-orange-500"
                />
                <span className="text-[10px] text-slate-400">Nếu để trống, hệ thống sẽ tự sinh mã duy nhất.</span>
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Tên Chuyền / Line hiển thị (*):</label>
                <input
                  type="text"
                  required
                  placeholder="Ví dụ: Line Rivet 3, Line May 1, Line Sơn..."
                  value={newLineName}
                  onChange={(e) => setNewLineName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-semibold focus:outline-none focus:border-orange-500"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 mb-1">Mô tả thêm:</label>
                <textarea
                  rows={2}
                  placeholder="Mô tả công đoạn, vị trí xưởng..."
                  value={newLineDesc}
                  onChange={(e) => setNewLineDesc(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-orange-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowAddLineModal(false)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl"
                >
                  Hủy bỏ
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white font-bold rounded-xl shadow-md shadow-orange-200"
                >
                  Lưu Line Mới
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
export default ProductivityQualityPage;
