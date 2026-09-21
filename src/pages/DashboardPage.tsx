import React, { useMemo, useState, useEffect } from 'react';
import { 
  Users, 
  UserCheck, 
  UserPlus, 
  UserMinus, 
  Clock, 
  AlertTriangle, 
  Calendar, 
  ShieldAlert, 
  ArrowRight,
  TrendingUp,
  TrendingDown,
  Percent,
  Building,
  BarChart3,
  CalendarCheck,
  CheckCircle2,
  DollarSign,
  Briefcase,
  Layers,
  Award,
  ChevronRight,
  Download,
  Plus,
  MoreVertical,
  SlidersHorizontal,
  LogIn,
  LogOut
} from 'lucide-react';
import { useLiveTable } from '../lib/tables';
import type { IEmployee, IDailyTimesheetCell, IShiftRosterEntry, IOvertimeRecord, ILeaveRequest } from '../types';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { NavPageId } from '../components/layout/Sidebar';
import { getPayPeriod, isInPayPeriod, formatPayPeriodLabel, parseDateLoose } from '../services/pay-period';

interface DashboardPageProps {
  onNavigate: (page: NavPageId) => void;
}

export const DashboardPage: React.FC<DashboardPageProps> = ({ onNavigate }) => {
  const { t, language } = useLanguage();
  const { session } = useAuth();

  // Query live data từ Supabase (realtime qua postgres_changes)
  const employees = useLiveTable<IEmployee>('employees');
  const timesheets = useLiveTable<IDailyTimesheetCell>('dailyTimesheets');
  const shiftRosters = useLiveTable<IShiftRosterEntry>('shiftRosters');
  const overtimes = useLiveTable<IOvertimeRecord>('overtimeRecords');
  const leaveRequests = useLiveTable<ILeaveRequest>('leaveRequests');

  const [targetMonth, setTargetMonth] = useState<number>(() => {
    const saved = localStorage.getItem('smarthr_selected_month');
    return saved ? parseInt(saved, 10) : 8;
  });
  const [targetYear, setTargetYear] = useState<number>(() => {
    const saved = localStorage.getItem('smarthr_selected_year');
    return saved ? parseInt(saved, 10) : 2026;
  });

  useEffect(() => {
    const handler = (e: any) => {
      if (e.detail?.month) setTargetMonth(e.detail.month);
      if (e.detail?.year) setTargetYear(e.detail.year);
    };
    window.addEventListener('timesheet:period_changed', handler);
    return () => window.removeEventListener('timesheet:period_changed', handler);
  }, []);

  const now = new Date();
  const officialPay = { payMonth: targetMonth, payYear: targetYear };
  const seasonalPay = { payMonth: targetMonth, payYear: targetYear };
  const currentMonth = targetMonth;
  const currentYear = targetYear;
  const officialPayLabel = formatPayPeriodLabel(targetMonth, targetYear, 'OFFICIAL');
  const seasonalPayLabel = formatPayPeriodLabel(targetMonth, targetYear, 'SEASONAL');

  // Helper parse DD/MM/YYYY or YYYY-MM-DD (dùng parseDateLoose chung)
  const parseDate = parseDateLoose;

  // Compute all Dashboard Metrics - 8 KPI mới
  const stats = useMemo(() => {
    const total = employees.length;
    const official = employees.filter(e => e.contractType === 'OFFICIAL').length;
    const seasonal = employees.filter(e => e.contractType === 'SEASONAL').length;

    const shift1 = employees.filter(e => e.shiftClassId === 'SHIFT_1').length;
    const shift2 = employees.filter(e => e.shiftClassId === 'SHIFT_2').length;

    // KPI 3 & 4: nhận việc / nghỉ việc theo KỲ CÔNG (21-20 cho OFFICIAL, 01-31 cho SEASONAL)
    const newHiresThisMonth = employees.filter(e => {
      const d = parseDate(e.startDate);
      if (!d) return false;
      const pp = getPayPeriod(d, e.contractType);
      const cur = e.contractType === 'SEASONAL' ? seasonalPay : officialPay;
      return pp.payMonth === cur.payMonth && pp.payYear === cur.payYear;
    }).length;

    const resignedThisMonth = employees.filter(e => {
      if (e.status !== 'RESIGNED') return false;
      if (e.resignedDate) {
        const d = parseDate(e.resignedDate);
        if (!d) return false;
        const pp = getPayPeriod(d, e.contractType);
        const cur = e.contractType === 'SEASONAL' ? seasonalPay : officialPay;
        return pp.payMonth === cur.payMonth && pp.payYear === cur.payYear;
      }
      return false;
    }).length;

    // KPI 5: turnover = resignedThisMonth / total % (nếu total 0 thì 0)
    const turnoverRate = total > 0 ? ((resignedThisMonth / total) * 100).toFixed(1) : '0.0';

    // KPI 6: tổng giờ tăng ca kỳ hiện tại (theo kỳ công + loại trừ thử việc)
    const isInProbation = (emp: any, ref: Date) => {
      if (!emp?.probationEndDate) return false;
      const d = parseDate(emp.probationEndDate);
      if (!d) return false;
      return ref < d;
    };
    const overtimeThisMonth = overtimes.filter(o => {
      const emp = employees.find(e => e.employeeId === o.employeeId);
      if (emp && isInProbation(emp, now)) return false; // thử việc không tính tăng ca
      const ct = emp?.contractType || 'OFFICIAL';
      const cur = ct === 'SEASONAL' ? seasonalPay : officialPay;
      return isInPayPeriod(o.date, ct, cur.payMonth, cur.payYear);
    });
    const totalOvertimeHoursThisMonth = overtimeThisMonth.reduce((sum, o) => sum + (o.hours || 0), 0);

    // KPI 7 & 8: đếm chính xác đi trễ, về sớm, thiếu quẹt thẻ trong kỳ công
    let totalLateCount = 0;
    let totalEarlyCount = 0;
    let totalMissingIn = 0;
    let totalMissingOut = 0;
    let totalWorkdaySlots = 0;

    const isAttendanceRecord = (code?: string) => {
      const c = (code || '').trim();
      return ['W', 'N', 'LA', 'ED', 'MCO', 'MCI', 'Off', 'OFF'].includes(c) || c.startsWith('W');
    };

    timesheets.forEach(ts => {
      const code = (ts.statusCode || '').trim();
      if (!isAttendanceRecord(code)) return;
      const emp = employees.find(e => e.employeeId === ts.employeeId);
      const ct = emp?.contractType || 'OFFICIAL';
      const cur = ct === 'SEASONAL' ? seasonalPay : officialPay;
      if (!isInPayPeriod(ts.date, ct, cur.payMonth, cur.payYear)) return;
      totalWorkdaySlots++;

      if (code === 'LA' || (ts.lateMinutes && ts.lateMinutes > 0 && ts.lateMinutes < 60)) {
        totalLateCount++;
      }
      if (code === 'ED' || (ts.earlyMinutes && ts.earlyMinutes > 0 && ts.earlyMinutes < 60)) {
        totalEarlyCount++;
      }
      if (code === 'MCI' || (!ts.checkIn && ts.checkOut)) {
        totalMissingIn++;
      }
      if (code === 'MCO' || (ts.checkIn && !ts.checkOut)) {
        totalMissingOut++;
      }
    });

    const totalLateEarly = totalLateCount + totalEarlyCount;
    const totalMissingPunch = totalMissingIn + totalMissingOut;

    // Department breakdown for Employees By Department (cột 1 và cột 3)
    const deptMap: Record<string, { total: number; official: number; seasonal: number }> = {};
    employees.forEach(e => {
      const dept = e.department || 'Production';
      if (!deptMap[dept]) deptMap[dept] = { total: 0, official: 0, seasonal: 0 };
      deptMap[dept].total++;
      if (e.contractType === 'OFFICIAL') deptMap[dept].official++;
      else deptMap[dept].seasonal++;
    });

    const departmentChartData = Object.keys(deptMap).map(k => ({
      name: k,
      total: deptMap[k].total,
      official: deptMap[k].official,
      seasonal: deptMap[k].seasonal,
    }));

    // Danh sách nghỉ chưa bù phép (bao gồm nửa ngày) - cột 3 - theo kỳ công hiện tại
    const pendingLeaveByDept: Record<string, number> = {};
    const halfDayByDept: Record<string, number> = {};
    leaveRequests.forEach(lr => {
      if (lr.status !== 'PENDING') return;
      const emp = employees.find(e => e.employeeId === lr.employeeId);
      const ct = (emp?.contractType || 'OFFICIAL') as 'OFFICIAL' | 'SEASONAL';
      const cur = ct === 'SEASONAL' ? seasonalPay : officialPay;
      if (!isInPayPeriod(lr.date, ct, cur.payMonth, cur.payYear)) return;
      const dept = lr.department || emp?.department || 'Production';
      if (lr.durationDays === 0.5) {
        halfDayByDept[dept] = (halfDayByDept[dept] || 0) + 1;
      } else {
        pendingLeaveByDept[dept] = (pendingLeaveByDept[dept] || 0) + 1;
      }
    });
    const pendingHalfDayData = Object.keys(deptMap).map(k => ({
      name: k,
      pending: pendingLeaveByDept[k] || 0,
      halfDay: halfDayByDept[k] || 0,
      total: (pendingLeaveByDept[k] || 0) + (halfDayByDept[k] || 0),
    })).sort((a,b) => b.total - a.total);

    // 12h Rest Violations - theo kỳ công hiện tại
    let total12hViolations = 0;
    shiftRosters.forEach(sr => {
      if (!sr.isRestViolation) return;
      const emp = employees.find(e => e.employeeId === sr.employeeId);
      const ct = (emp?.contractType || 'OFFICIAL') as 'OFFICIAL' | 'SEASONAL';
      const cur = ct === 'SEASONAL' ? seasonalPay : officialPay;
      if (!isInPayPeriod(sr.date, ct, cur.payMonth, cur.payYear)) return;
      total12hViolations++;
    });

    // Top 10 violators: tổng mọi vi phạm (late 60 + early 60 + missingIn/out + 12h) theo kỳ công hiện tại
    const violatorMap: Record<string, { employeeId: string; fullName: string; count: number }> = {};
    const addViol = (empId: string, inc=1) => {
      if (!empId) return;
      const emp = employees.find(e => e.employeeId === empId);
      const key = empId;
      if (!violatorMap[key]) violatorMap[key] = { employeeId: empId, fullName: emp?.fullName || empId, count: 0 };
      violatorMap[key].count += inc;
    };
    timesheets.forEach(ts => {
      const emp = employees.find(e => e.employeeId === ts.employeeId);
      const ct = (emp?.contractType || 'OFFICIAL') as 'OFFICIAL' | 'SEASONAL';
      const cur = ct === 'SEASONAL' ? seasonalPay : officialPay;
      if (!isInPayPeriod(ts.date, ct, cur.payMonth, cur.payYear)) return;
      if (!isAttendanceRecord(ts.statusCode)) return;
      if (ts.lateMinutes && ts.lateMinutes > 0 && ts.lateMinutes <= 60) addViol(ts.employeeId, 1);
      if (ts.earlyMinutes && ts.earlyMinutes > 0 && ts.earlyMinutes <= 60) addViol(ts.employeeId, 1);
      const hasIn = !!ts.checkIn;
      const hasOut = !!ts.checkOut;
      if ((!hasIn && hasOut) || (hasIn && !hasOut)) addViol(ts.employeeId, 1);
    });
    shiftRosters.forEach(sr => {
      const emp = employees.find(e => e.employeeId === sr.employeeId);
      const ct = (emp?.contractType || 'OFFICIAL') as 'OFFICIAL' | 'SEASONAL';
      const cur = ct === 'SEASONAL' ? seasonalPay : officialPay;
      if (!isInPayPeriod(sr.date, ct, cur.payMonth, cur.payYear)) return;
      if (sr.isRestViolation) addViol(sr.employeeId, 1);
    });
    const topViolators = Object.values(violatorMap).sort((a,b) => b.count - a.count).slice(0, 10);

    const pendingLeave = leaveRequests.filter(r => r.status === 'PENDING').length;
    const pendingOT = overtimes.filter(o => o.verificationStatus === 'PENDING').length;

    return {
      total,
      official,
      seasonal,
      shift1,
      shift2,
      newHiresThisMonth,
      resignedThisMonth,
      turnoverRate,
      totalOvertimeHoursThisMonth,
      totalLateCount,
      totalEarlyCount,
      totalLateEarly,
      totalMissingIn,
      totalMissingOut,
      totalMissingPunch,
      totalWorkdaySlots,
      total12hViolations,
      pendingLeave,
      pendingOT,
      departmentChartData,
      pendingHalfDayData,
      topViolators,
      officialPay,
      seasonalPay,
      officialPayLabel,
      seasonalPayLabel,
    };
  }, [employees, timesheets, shiftRosters, overtimes, leaveRequests, currentMonth, currentYear, officialPay, seasonalPay, officialPayLabel, seasonalPayLabel]);

  const maxDept = useMemo(() => {
    return Math.max(1, ...stats.departmentChartData.map(d => d.total));
  }, [stats.departmentChartData]);

  const maxPendingHalf = useMemo(() => {
    return Math.max(1, ...stats.pendingHalfDayData.map(d => d.total));
  }, [stats.pendingHalfDayData]);

  const displayName = session?.displayName || (language === 'vi' ? 'Mia Kiều' : 'Mia Kieu');
  const welcomeText = t('welcomeBack');

  return (
    <div className="p-6 w-full space-y-6 font-sans">
      {/* 2. Welcome Back Banner - chào đúng người đăng nhập, đồng bộ VI/EN */}
      <div className="bg-white rounded-2xl p-5 border border-slate-200 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="relative">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-[#FF5B26] to-[#FFA07A] flex items-center justify-center text-white text-xl font-black shadow-md shadow-orange-200">
              {displayName.charAt(0).toUpperCase()}
            </div>
            <div className="absolute -bottom-1 -right-1 w-5 h-5 bg-blue-500 rounded-full border-2 border-white flex items-center justify-center text-white text-[10px]">
              ✓
            </div>
          </div>
          <div>
            <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
              <span>{welcomeText} {displayName}</span>
              <span className="text-xs">👋</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {language === 'vi' ? 'Bạn có' : 'You have'}{' '}
              <button 
                onClick={() => onNavigate('overtime')}
                className="font-bold text-[#FF5B26] underline decoration-orange-300 hover:text-orange-700"
              >
                {stats.pendingOT} {language === 'vi' ? 'phê duyệt chờ' : 'Pending Approvals'}
              </button>{' '}
              &{' '}
              <button 
                onClick={() => onNavigate('leavePending')}
                className="font-bold text-[#FF5B26] underline decoration-orange-300 hover:text-orange-700"
              >
                {stats.pendingLeave} {language === 'vi' ? 'yêu cầu nghỉ' : 'Leave Requests'}
              </button>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 w-full md:w-auto">
          <button
            onClick={() => onNavigate('timesheet')}
            className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl transition"
          >
            <Download className="w-4 h-4 text-slate-500" />
            <span>{language === 'vi' ? 'Xuất báo cáo' : 'Export Report'}</span>
          </button>
          <button
            onClick={() => onNavigate('shiftAssignment')}
            className="flex-1 md:flex-none flex items-center justify-center gap-2 px-4 py-2.5 bg-[#0F172A] hover:bg-slate-800 text-white text-xs font-bold rounded-xl transition shadow-md shadow-slate-900/20"
          >
            <Plus className="w-4 h-4 text-orange-400" />
            <span>{language === 'vi' ? 'Thêm lịch' : '+ Add Schedule'}</span>
          </button>
        </div>
      </div>

      {/* Pay Period Info - chu kỳ công chuẩn */}
      <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
        <div className="flex flex-col gap-1">
          <div className="font-extrabold text-slate-900 flex items-center gap-2">
            <CalendarCheck className="w-4 h-4 text-orange-500" />
            <span>{language==='vi' ? 'Kỳ công hiện tại' : 'Current Pay Period'}</span>
          </div>
          <div className="text-[11px] text-slate-600 flex flex-col sm:flex-row gap-2 sm:gap-4">
            <span className="px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg font-bold">Chính thức (21-20): {stats.officialPayLabel}</span>
            <span className="px-2.5 py-1 bg-orange-50 text-orange-700 border border-orange-200 rounded-lg font-bold">Thời vụ (01-31): {stats.seasonalPayLabel}</span>
          </div>
        </div>
        <div className="text-[11px] text-slate-500 max-w-md leading-relaxed">
          {language==='vi' ? 'Ví dụ: 27/08/2026 → kỳ Tháng 9 (21/08-20/09) cho Chính thức, Tháng 8 cho Thời vụ. Báo cáo sai phạm tính theo kỳ này.' : 'Example: 27/08/2026 → Sep period (21/08-20/09) for Official, Aug for Seasonal.'}
        </div>
      </div>

      {/* 3. 8 KPI Cards mới */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* KPI 1: Tổng số nhân viên */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <div className="w-10 h-10 rounded-xl bg-[#FFF2EE] flex items-center justify-center text-[#FF5B26]">
              <Users className="w-5 h-5" />
            </div>
            <span className="text-[10px] font-bold text-slate-500 bg-slate-50 px-2 py-0.5 rounded-full border">
              {language === 'vi' ? 'Tổng' : 'Total'}
            </span>
          </div>
          <div className="text-xs font-bold text-slate-500 mt-3">{t('kpiTotalEmployees')}</div>
          <div className="text-2xl font-black text-slate-900 mt-1">{stats.total}</div>
          <div className="text-[11px] text-slate-500 mt-1">
            {t('seasonalEmployees')}: <b className="text-slate-900">{stats.seasonal}</b> • {t('officialEmployees')}: <b className="text-slate-900">{stats.official}</b>
          </div>
        </div>

        {/* KPI 2: Đang đi ca */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-800">
              <Clock className="w-5 h-5" />
            </div>
            <span className="text-[10px] font-bold text-slate-500 bg-slate-50 px-2 py-0.5 rounded-full border">{stats.shift1 + stats.shift2}/{stats.total}</span>
          </div>
          <div className="text-xs font-bold text-slate-500 mt-3">{t('kpiEmployeesOnShift')}</div>
          <div className="text-2xl font-black text-slate-900 mt-1">{stats.shift1 + stats.shift2}</div>
          <div className="text-[11px] text-slate-500 mt-1">
            {t('shift1Count')}: <b className="text-indigo-700">{stats.shift1}</b> • {t('shift2Count')}: <b className="text-pink-700">{stats.shift2}</b>
          </div>
        </div>

        {/* KPI 3: Nhận việc tháng này */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600">
              <UserPlus className="w-5 h-5" />
            </div>
            <span className="inline-flex items-center gap-0.5 text-[11px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">+{stats.newHiresThisMonth}</span>
          </div>
          <div className="text-xs font-bold text-slate-500 mt-3">{t('kpiNewHiresMonth')}</div>
          <div className="text-2xl font-black text-slate-900 mt-1">+{stats.newHiresThisMonth}</div>
          <div className="text-[11px] text-slate-400 mt-1">{language==='vi' ? `Kỳ ${currentMonth}/${currentYear}` : `Period ${currentMonth}/${currentYear}`} <span className="text-[10px] text-slate-400">({stats.officialPayLabel})</span></div>
        </div>

        {/* KPI 4: Nghỉ việc tháng này */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <div className="w-10 h-10 rounded-xl bg-slate-900 flex items-center justify-center text-white">
              <UserMinus className="w-5 h-5" />
            </div>
            <span className="inline-flex items-center gap-0.5 text-[11px] font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full">-{stats.resignedThisMonth}</span>
          </div>
          <div className="text-xs font-bold text-slate-500 mt-3">{t('kpiResignedMonth')}</div>
          <div className="text-2xl font-black text-slate-900 mt-1">{stats.resignedThisMonth}</div>
          <div className="text-[11px] text-slate-400 mt-1">{language === 'vi' ? 'Trạng thái RESIGNED' : 'Status RESIGNED'}</div>
        </div>

        {/* KPI 5: Tỷ lệ nghỉ việc */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <div className="w-10 h-10 rounded-xl bg-rose-50 flex items-center justify-center text-rose-600">
              <Percent className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full">{stats.turnoverRate}%</span>
          </div>
          <div className="text-xs font-bold text-slate-500 mt-3">{t('kpiTurnoverMonth')}</div>
          <div className="text-2xl font-black text-slate-900 mt-1">{stats.turnoverRate}%</div>
          <div className="text-[11px] text-slate-400 mt-1">{stats.resignedThisMonth}/{stats.total} {language === 'vi' ? 'đã xóa' : 'deleted'}</div>
        </div>

        {/* KPI 6: Tổng giờ tăng ca tháng này */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center text-purple-600">
              <Briefcase className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-bold text-purple-600 bg-purple-50 px-2 py-0.5 rounded-full">Kỳ {currentMonth}/{currentYear}</span>
           </div>
           <div className="text-xs font-bold text-slate-500 mt-3">{t('kpiOvertimeMonth')}</div>
           <div className="text-2xl font-black text-slate-900 mt-1">{stats.totalOvertimeHoursThisMonth.toFixed(1)}h</div>
           <div className="text-[11px] text-slate-400 mt-1">{stats.totalOvertimeHoursThisMonth > 0 ? `${overtimes.filter(o => { const emp = employees.find(e=>e.employeeId===o.employeeId); const ct = emp?.contractType||'OFFICIAL'; const cur = ct==='SEASONAL'? seasonalPay: officialPay; return isInPayPeriod(o.date, ct, cur.payMonth, cur.payYear); }).length} bản ghi` : (language==='vi'?'Chưa có':'No records')}</div>
        </div>

        {/* KPI 7: Trễ / Sớm (≤60p) */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-amber-600">
              <Calendar className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">{stats.totalLateEarly} lượt</span>
          </div>
          <div className="text-xs font-bold text-slate-500 mt-3">{t('kpiLateEarly')}</div>
          <div className="text-2xl font-black text-slate-900 mt-1">{stats.totalLateEarly}</div>
          <div className="text-[11px] text-slate-500 mt-1">
            {language==='vi' ? 'Trễ' : 'Late'}: <b className="text-amber-700">{stats.totalLateCount}</b> • {language==='vi' ? 'Sớm' : 'Early'}: <b className="text-blue-700">{stats.totalEarlyCount}</b> <span className="text-[10px] text-slate-400">(≤60p)</span>
          </div>
        </div>

        {/* KPI 8: Không bấm thẻ vào/ra */}
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm hover:shadow-md transition">
          <div className="flex items-center justify-between">
            <div className="w-10 h-10 rounded-xl bg-rose-50 flex items-center justify-center text-rose-600">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded-full">{stats.totalMissingPunch} lượt</span>
          </div>
          <div className="text-xs font-bold text-slate-500 mt-3">{t('kpiMissingPunch')}</div>
          <div className="text-2xl font-black text-slate-900 mt-1">{stats.totalMissingPunch}</div>
          <div className="text-[11px] text-slate-500 mt-1">
            {language==='vi' ? 'Không vào' : 'Missing In'}: <b className="text-rose-700">{stats.totalMissingIn}</b> • {language==='vi' ? 'Không ra' : 'Missing Out'}: <b className="text-orange-700">{stats.totalMissingOut}</b>
          </div>
        </div>
      </div>

      {/* 4. Middle 3-Column: Employees By Department | Attendance TOP10 multi-arc | Pending/HalfDay */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Column 1: Employees By Department (thay Employee Status cũ) */}
        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-extrabold text-slate-900">{t('chartEmployeesByDept')}</h3>
            <span className="px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-lg text-[11px] font-semibold text-slate-600">
              {language==='vi' ? 'Tổng' : 'Total'} {stats.total}
            </span>
          </div>
          <div className="space-y-3">
            {stats.departmentChartData.slice(0, 6).map((d) => {
              const pct = maxDept > 0 ? (d.total / maxDept) * 100 : 0;
              return (
                <div key={d.name} className="space-y-1">
                  <div className="flex items-center justify-between text-xs font-bold">
                    <span className="text-slate-700">{d.name}</span>
                    <span className="text-slate-900 font-extrabold">{d.total} NV</span>
                  </div>
                  <div className="h-2.5 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div style={{ width: `${pct}%` }} className="h-full bg-[#FF5B26] rounded-full transition-all duration-300" />
                  </div>
                  <div className="text-[10px] text-slate-500">{t('officialEmployees')}: {d.official} • {t('seasonalEmployees')}: {d.seasonal}</div>
                </div>
              );
            })}
          </div>
          <button onClick={() => onNavigate('employees')} className="w-full mt-4 py-2.5 bg-slate-50 hover:bg-slate-100 text-slate-700 font-bold text-xs rounded-xl border border-slate-200 transition text-center">
            {language==='vi' ? 'Xem tất cả nhân viên' : 'View All Employees'}
          </button>
        </div>

        {/* Column 2: Attendance Overview - TOP10 nhiều cung (đồng bộ thẻ trắng như hệ thống) */}
        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm flex flex-col overflow-hidden relative">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-extrabold text-slate-900">{t('chartAttendanceOverview')}</h3>
            <span className="px-2.5 py-1 bg-slate-50 border border-slate-200 rounded-lg text-[11px] font-semibold text-slate-600">
              Top 10
            </span>
          </div>

          {/* Multi-arc pie - số lượng nhiều => cung dài tương ứng */}
          <div className="relative flex flex-col items-center justify-center py-2 flex-1">
            <div className="relative w-56 h-56 flex items-center justify-center">
              {/* Nền vòng xám nhạt cho thẻ trắng */}
              <div className="absolute inset-0 rounded-full opacity-40" style={{ background: 'repeating-radial-gradient(circle at center, transparent 14px, #E2E8F0 15px, #E2E8F0 16px, transparent 16px, transparent 28px)' }} />
              <svg className="w-56 h-56 rotate-[-90deg]" viewBox="0 0 200 200">
                {/* Vẽ 10 cung đồng tâm - mỗi MSNV một màu rõ ràng, độ dài tỉ lệ trực tiếp với số lần vi phạm */}
                {(() => {
                  const max = Math.max(1, ...stats.topViolators.map(v => v.count));
                  // Bảng màu trực quan trên nền trắng, độ tương phản cao
                  const colors = ['#0EA5E9', '#8B5CF6', '#F59E0B', '#EF4444', '#10B981', '#06B6D4', '#EC4899', '#6366F1', '#F97316', '#14B8A6'];
                  return stats.topViolators.slice(0, 10).map((v, i) => {
                    const radius = 75 - i * 6;
                    const circumference = 2 * Math.PI * radius;
                    const pct = v.count / max;
                    // Độ dài cung phản ánh trực tiếp số lượng: nhiều = dài, ít = ngắn (tối thiểu 12% vòng, tối đa 87%)
                    const dash = circumference * (0.12 + pct * 0.75);
                    const gap = circumference - dash;
                    const rotate = i * 3;
                    return (
                      <circle
                        key={v.employeeId}
                        cx="100" cy="100" r={radius}
                        fill="none"
                        stroke={colors[i % colors.length]}
                        strokeWidth={i < 3 ? 5 : 3.5}
                        strokeLinecap="round"
                        strokeDasharray={`${dash} ${gap}`}
                        strokeDashoffset={-rotate}
                        style={{ filter: `drop-shadow(0 0 4px ${colors[i % colors.length]}66)`, opacity: 0.92 }}
                      />
                    );
                  });
                })()}
                {/* Vòng trung tâm TOP 10 - nền trắng đồng bộ */}
                <circle cx="100" cy="100" r="38" fill="none" stroke="#EF4444" strokeWidth="3" style={{ filter: 'drop-shadow(0 0 6px #EF444444)' }} />
                <circle cx="100" cy="100" r="32" fill="#FFFFFF" stroke="#EF4444" strokeWidth="1" />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="text-[10px] font-black tracking-widest text-slate-700">TOP 10</div>
                <div className="text-[10px] font-bold text-rose-500 tracking-wider">{language==='vi' ? 'VI PHẠM' : 'VIOLATORS'}</div>
              </div>
            </div>

            {/* Legend top 10 theo MSNV - màu sắc mô tả rõ ràng, trực quan */}
            <div className="w-full mt-3 space-y-1 max-h-[132px] overflow-y-auto pr-1">
              {stats.topViolators.length === 0 ? (
                <div className="text-[11px] text-slate-500 text-center py-4 bg-slate-50 rounded-xl border border-dashed">{language==='vi' ? 'Chưa có vi phạm trong tháng' : 'No violations this month'}</div>
              ) : (
                (() => {
                  const legendColors = ['#0EA5E9', '#8B5CF6', '#F59E0B', '#EF4444', '#10B981', '#06B6D4', '#EC4899', '#6366F1', '#F97316', '#14B8A6'];
                  return stats.topViolators.map((v, i) => (
                    <div key={v.employeeId} className="flex items-center gap-2 text-[11px] bg-slate-50 rounded-lg px-2.5 py-1.5 border border-slate-200 hover:bg-slate-100 transition">
                      <span className="w-3 h-3 rounded-full shrink-0 border border-white shadow-sm" style={{ backgroundColor: legendColors[i % legendColors.length] }} title={`Màu MSNV ${v.employeeId}`} />
                      <span className="font-mono font-bold text-slate-800">{i+1}. {v.employeeId}</span>
                      <span className="text-slate-500 truncate ml-1 flex-1">{v.fullName}</span>
                      <span className="ml-auto font-black shrink-0" style={{ color: legendColors[i % legendColors.length] }}>{v.count} {language==='vi' ? 'lần' : 'times'}</span>
                    </div>
                  ));
                })()
              )}
            </div>
          </div>

          <button onClick={() => onNavigate('timesheet')} className="w-full mt-4 py-2.5 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs rounded-xl border border-slate-200 transition text-center shadow-sm">
            {language==='vi' ? 'Xem bảng chấm công' : 'View Timesheet'}
          </button>
        </div>

        {/* Column 3: Danh sách nghỉ chưa bù phép (bao gồm nửa ngày) - theo kỳ công hiện tại */}
        <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-extrabold text-slate-900 leading-tight">{t('chartPendingHalfDay')}</h3>
            <span className="text-[11px] font-bold text-slate-400 shrink-0 ml-2 text-right">Kỳ {currentMonth}/{currentYear}<br/><span className="text-[10px] font-normal">{stats.officialPayLabel}</span></span>
          </div>

          <div className="space-y-3">
            {stats.pendingHalfDayData.slice(0, 6).map((d) => {
              const pct = maxPendingHalf > 0 ? (d.total / maxPendingHalf) * 100 : 0;
              const pendingPct = d.total > 0 ? (d.pending / d.total) * 100 : 0;
              return (
                <div key={d.name} className="space-y-1">
                  <div className="flex items-center justify-between text-xs font-bold">
                    <span className="text-slate-700">{d.name}</span>
                    <span className="text-slate-900 font-extrabold">{d.total} {language==='vi' ? 'lượt' : 'cases'}</span>
                  </div>
                  <div className="h-2.5 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div style={{ width: `${pct}%` }} className="h-full flex rounded-full overflow-hidden transition-all duration-300">
                      <div style={{ width: `${pendingPct}%` }} className="h-full bg-amber-500" title={`Chưa bù: ${d.pending}`} />
                      <div style={{ width: `${100 - pendingPct}%` }} className="h-full bg-blue-500" title={`Nửa ngày: ${d.halfDay}`} />
                    </div>
                  </div>
                  <div className="flex justify-between text-[10px] font-semibold">
                    <span className="text-amber-600">● {language==='vi' ? 'Chưa bù' : 'Pending'}: {d.pending}</span>
                    <span className="text-blue-600">● {language==='vi' ? 'Nửa ngày' : 'Half-day'}: {d.halfDay}</span>
                  </div>
                </div>
              );
            })}
            {stats.pendingHalfDayData.every(d => d.total===0) && (
              <div className="text-center py-6 text-xs text-slate-400 bg-slate-50 rounded-xl border border-dashed">{language==='vi' ? 'Không có nghỉ chưa bù / nửa ngày trong tháng' : 'No pending/half-day this month'}</div>
            )}
          </div>
          <div className="text-[11px] font-bold text-slate-500 mt-3 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
            {language==='vi' ? 'Dữ liệu theo tháng hiện tại, đồng bộ trực tiếp menu Chờ bù phép: duyệt = đã bù, chưa duyệt = chưa bù' : 'Monthly data synced directly from Pending Leave menu: approved = compensated, pending = uncompensated'}
          </div>

          <button onClick={() => onNavigate('leavePending')} className="w-full mt-4 py-2.5 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs rounded-xl border border-slate-200 transition text-center shadow-sm">
            {language==='vi' ? 'Xem danh sách chờ bù phép' : 'View Pending Leave'}
          </button>
        </div>
      </div>
    </div>
  );
};
