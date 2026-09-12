import React from 'react';
import { 
  LayoutDashboard, 
  Users, 
  CalendarDays, 
  Clock, 
  CalendarCheck, 
  RotateCcw, 
  ScanLine, 
  Settings,
  Briefcase,
  ClipboardList,
  ExternalLink,
  ShieldAlert,
  ShieldCheck,
  TrendingUp
} from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../db';

export type NavPageId = 
  | 'dashboard' 
  | 'employees' 
  | 'timesheet' 
  | 'productivityQuality'
  | 'overtime' 
  | 'leavePending' 
  | 'shiftRoster' 
  | 'shiftAssignment'
  | 'attendanceViolation'
  | 'ocrVerification' 
  | 'userManagement'
  | 'settings';

interface SidebarProps {
  activePage: NavPageId;
  onSelectPage: (page: NavPageId) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activePage, onSelectPage }) => {
  const { t } = useLanguage();
  const { session, currentRole, hasPermission } = useAuth();
  const isMasterUser = currentRole === 'AD System' || currentRole === 'HR Manager' || currentRole === 'HR Admin';
  const isHostOrHR = session?.username?.toLowerCase() === 'kieu' || session?.username?.toLowerCase() === 'hoa' || currentRole === 'HR Manager';

  // v6: dùng Flag 0|1 thay boolean để index hợp lệ (IndexedDB chỉ cho Number/String/Date)
  const badgeCounts = useLiveQuery(async () => {
    const [pendingLeave, violations, pendingOT, attendanceViolations] = await Promise.all([
      db.leaveRequests.where('status').equals('PENDING').count(),
      db.shiftRosters.where('isRestViolationFlag').equals(1).count(),
      db.overtimeRecords.where('verificationStatus').equals('PENDING').count(),
      db.dailyTimesheets.where('statusCode').anyOf(['LA','ED','MCO','MCI']).count(),
    ]);
    return { pendingLeave, violations, pendingOT, attendanceViolations };
  }, []);
  const pendingLeaveCount = badgeCounts?.pendingLeave ?? 0;
  const shiftViolationCount = badgeCounts?.violations ?? 0;
  const pendingOTCount = badgeCounts?.pendingOT ?? 0;
  const attendanceViolationCount = badgeCounts?.attendanceViolations ?? 0;

  const menuItemClass = (isActive: boolean) => `w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium transition ${
    isActive
      ? 'bg-[#FFF5F2] text-[#FF5B26] border-l-4 border-[#FF5B26] rounded-l-none font-bold'
      : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
  }`;

  return (
    <aside className="w-64 bg-white text-slate-600 flex flex-col shrink-0 border-r border-slate-200 select-none overflow-y-auto font-sans">
      {/* Navigation - flat, không còn accordion, không còn MAIN MENU / HR Applications header - logo nhỏ đã xóa, chỉ giữ logo to trên Header */}
      <div className="h-3 border-b border-slate-100 bg-white shrink-0" aria-hidden="true" />

      {/* Navigation - flat, không còn accordion, không còn MAIN MENU / HR Applications header */}
      <div className="p-3 space-y-1 flex-1 text-xs">
        {/* Dashboard */}
        {(hasPermission('VIEW_DASHBOARD') || hasPermission('VIEW_DEPT_DASHBOARD')) && (
          <button
            onClick={() => onSelectPage('dashboard')}
            className={menuItemClass(activePage === 'dashboard')}
          >
            <div className="flex items-center gap-2.5">
              <LayoutDashboard className={`w-4 h-4 ${activePage === 'dashboard' ? 'text-[#FF5B26]' : 'text-slate-500'}`} />
              <span>Dashboard</span>
            </div>
          </button>
        )}

        {/* Employee Master Catalog */}
        {(hasPermission('MANAGE_EMPLOYEES') || hasPermission('VIEW_DEPT_EMPLOYEES')) && (
          <button
            onClick={() => onSelectPage('employees')}
            className={menuItemClass(activePage === 'employees')}
          >
            <div className="flex items-center gap-2.5">
              <Users className={`w-4 h-4 ${activePage === 'employees' ? 'text-[#FF5B26]' : 'text-slate-400'}`} />
              <span>{t('employees')}</span>
            </div>
          </button>
        )}

        {/* Timesheet - đã đổi thành Bảng Chấm Công */}
        {(hasPermission('MANAGE_TIMESHEET') || hasPermission('VIEW_DEPT_TIMESHEET')) && (
          <button
            onClick={() => onSelectPage('timesheet')}
            className={menuItemClass(activePage === 'timesheet')}
          >
            <div className="flex items-center gap-2.5">
              <CalendarDays className={`w-4 h-4 ${activePage === 'timesheet' ? 'text-[#FF5B26]' : 'text-slate-400'}`} />
              <span>{t('timesheet')}</span>
            </div>
          </button>
        )}

        {/* Tỷ Lệ Đạt Năng Suất & Chất Lượng */}
        {(hasPermission('VIEW_PRODUCTIVITY_QUALITY') || hasPermission('MANAGE_EMPLOYEES') || hasPermission('MANAGE_TIMESHEET')) && (
          <button
            onClick={() => onSelectPage('productivityQuality')}
            className={menuItemClass(activePage === 'productivityQuality')}
          >
            <div className="flex items-center gap-2.5">
              <TrendingUp className={`w-4 h-4 ${activePage === 'productivityQuality' ? 'text-[#FF5B26]' : 'text-slate-400'}`} />
              <span>Tỷ Lệ Đạt NS & CL</span>
            </div>
          </button>
        )}

        {/* Overtime Page */}
        {(hasPermission('MANAGE_OT') || hasPermission('PROPOSE_DEPT_OT')) && (
          <button
            onClick={() => onSelectPage('overtime')}
            className={menuItemClass(activePage === 'overtime')}
          >
            <div className="flex items-center gap-2.5">
              <Clock className={`w-4 h-4 ${activePage === 'overtime' ? 'text-[#FF5B26]' : 'text-slate-400'}`} />
              <span>{t('overtime')}</span>
            </div>
            {pendingOTCount > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-amber-100 text-amber-800">
                {pendingOTCount}
              </span>
            )}
          </button>
        )}

        {/* Leave Pending Page */}
        {(hasPermission('MANAGE_LEAVE') || hasPermission('VIEW_DEPT_LEAVE')) && (
          <button
            onClick={() => onSelectPage('leavePending')}
            className={menuItemClass(activePage === 'leavePending')}
          >
            <div className="flex items-center gap-2.5">
              <CalendarCheck className={`w-4 h-4 ${activePage === 'leavePending' ? 'text-[#FF5B26]' : 'text-slate-400'}`} />
              <span>{t('leavePending')}</span>
            </div>
            {pendingLeaveCount > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-rose-100 text-rose-800">
                {pendingLeaveCount}
              </span>
            )}
          </button>
        )}

        {/* Shift Roster & 12h Rest Violations - Chỉ HR, Admin, Software nhìn thấy */}
        {isMasterUser && (hasPermission('MANAGE_ROSTER') || hasPermission('MANAGE_DEPT_ROSTER')) && (
          <button
            onClick={() => onSelectPage('shiftRoster')}
            className={menuItemClass(activePage === 'shiftRoster')}
          >
            <div className="flex items-center gap-2.5">
              <RotateCcw className={`w-4 h-4 ${activePage === 'shiftRoster' ? 'text-[#FF5B26]' : 'text-slate-400'}`} />
              <span>{t('shiftRoster')}</span>
            </div>
            {shiftViolationCount > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-rose-600 text-white animate-pulse">
                {shiftViolationCount}
              </span>
            )}
          </button>
        )}

        {/* Sắp Xếp Ca Làm Việc - mới, nằm ngay dưới Phân Ca, lọc theo bộ phận, role-based */}
        {(hasPermission('MANAGE_ROSTER') || hasPermission('MANAGE_DEPT_ROSTER')) && (
          <button
            onClick={() => onSelectPage('shiftAssignment')}
            className={menuItemClass(activePage === 'shiftAssignment')}
          >
            <div className="flex items-center gap-2.5">
              <Briefcase className={`w-4 h-4 ${activePage === 'shiftAssignment' ? 'text-[#FF5B26]' : 'text-slate-400'}`} />
              <span>{isHostOrHR ? 'Tiếp Nhận Sắp Ca' : t('shiftAssignment')}</span>
            </div>
          </button>
        )}

        {/* Theo dõi Đi trễ/Về sớm/MCO/MCI - mới */}
        {(hasPermission('MANAGE_TIMESHEET') || hasPermission('VIEW_DEPT_TIMESHEET')) && (
          <button
            onClick={() => onSelectPage('attendanceViolation')}
            className={menuItemClass(activePage === 'attendanceViolation')}
          >
            <div className="flex items-center gap-2.5">
              <ShieldAlert className={`w-4 h-4 ${activePage === 'attendanceViolation' ? 'text-[#FF5B26]' : 'text-slate-400'}`} />
              <span>{t('attendanceViolation')}</span>
            </div>
            {attendanceViolationCount > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-orange-100 text-orange-800 border border-orange-200">
                {attendanceViolationCount}
              </span>
            )}
          </button>
        )}

        {/* OCR Overtime Verification */}
        {(hasPermission('SCAN_OCR') || hasPermission('SCAN_DEPT_OCR')) && (
          <button
            onClick={() => onSelectPage('ocrVerification')}
            className={menuItemClass(activePage === 'ocrVerification')}
          >
            <div className="flex items-center gap-2.5">
              <ScanLine className={`w-4 h-4 ${activePage === 'ocrVerification' ? 'text-[#FF5B26]' : 'text-slate-400'}`} />
              <span>{t('ocrVerification')}</span>
            </div>
          </button>
        )}

        {/* Quản lý User & Nhật Ký - Chỉ hiển thị khi có quyền MANAGE_USERS (Kieu, Glory) */}
        {hasPermission('MANAGE_USERS') && (
          <button
            onClick={() => onSelectPage('userManagement')}
            className={menuItemClass(activePage === 'userManagement')}
          >
            <div className="flex items-center gap-2.5">
              <ShieldCheck className={`w-4 h-4 ${activePage === 'userManagement' ? 'text-[#FF5B26]' : 'text-slate-400'}`} />
              <span>Người Dùng & Nhật Ký</span>
            </div>
          </button>
        )}

        {/* Settings & RBAC - Chỉ hiển thị cho Admin System có quyền SYSTEM_SETTINGS, HR Manager bị ẩn */}
        {hasPermission('SYSTEM_SETTINGS') && (
          <button
            onClick={() => onSelectPage('settings')}
            className={menuItemClass(activePage === 'settings')}
          >
            <div className="flex items-center gap-2.5">
              <Settings className={`w-4 h-4 ${activePage === 'settings' ? 'text-[#FF5B26]' : 'text-slate-400'}`} />
              <span>{t('settings')} & RBAC</span>
            </div>
          </button>
        )}

        {/* Tạo khảo sát - external link - Chỉ HR, Admin, Software nhìn thấy */}
        {isMasterUser && (
          <a
            href="https://survey-zd8.pages.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl font-medium transition text-slate-600 hover:bg-slate-50 hover:text-slate-900 group"
          >
            <div className="flex items-center gap-2.5">
              <ClipboardList className="w-4 h-4 text-slate-400 group-hover:text-[#FF5B26]" />
              <span>Tạo khảo sát</span>
            </div>
            <ExternalLink className="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600" />
          </a>
        )}
      </div>

      {/* User Footer Profile Card */}
      <div className="p-4 border-t border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-orange-400 to-amber-400 flex items-center justify-center text-white font-bold text-xs shadow-inner">
            {(session?.displayName ?? '?').charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-xs text-slate-900 truncate">{session?.displayName ?? 'Chưa đăng nhập'}</div>
            <div className="text-[10px] text-slate-400 truncate">{currentRole ?? ''}</div>
          </div>
        </div>
      </div>
    </aside>
  );
};
