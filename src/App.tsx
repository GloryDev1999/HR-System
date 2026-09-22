import React, { useState, useEffect } from 'react';
import { ToastProvider } from './context/ToastContext';
import { ModalProvider } from './context/ModalContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { LanguageProvider } from './context/LanguageContext';
import { Layout } from './components/layout/Layout';
import { LoginScreen } from './components/auth/LoginScreen';
import { NavPageId } from './components/layout/Sidebar';
import { ErrorBoundary } from './components/ui/ErrorBoundary';

// Pages
import { DashboardPage } from './pages/DashboardPage';
import { EmployeeListPage } from './pages/EmployeeListPage';
import { TimesheetCalendarPage } from './pages/TimesheetCalendarPage';
import { ProductivityQualityPage } from './pages/ProductivityQualityPage';
import { OvertimePage } from './pages/OvertimePage';
import { LeavePendingPage } from './pages/LeavePendingPage';
import { ShiftAssignmentPage } from './pages/ShiftAssignmentPage';
import { AttendanceViolationPage } from './pages/AttendanceViolationPage';
import { OCRVerificationPage } from './pages/OCRVerificationPage';
import { SettingsPage } from './pages/SettingsPage';
import { UserManagementPage } from './pages/UserManagementPage';

import { presenceManager } from './services/presence-service';

const Shell: React.FC = () => {
  const { session, currentRole, hasPermission, logout } = useAuth();
  const [activePage, setActivePage] = useState<NavPageId>('dashboard');
  const isMasterUser = currentRole === 'AD System' || currentRole === 'HR Manager' || currentRole === 'HR Admin';

  // Seed danh mục mặc định nằm trong supabase/schema.sql (shift_classes,
  // rbac_roles, production_lines, app_settings) — không seed client-side nữa.

  // Tự động điều hướng user restricted (Vinh, Nguyet Anh, Han) vào đúng menu được cấp quyền khi đăng nhập
  useEffect(() => {
    if (session) {
      const canDashboard = hasPermission('VIEW_DASHBOARD') || hasPermission('VIEW_DEPT_DASHBOARD');
      if (!canDashboard && activePage === 'dashboard') {
        if (hasPermission('MANAGE_ROSTER') || hasPermission('MANAGE_DEPT_ROSTER')) {
          setActivePage('shiftAssignment');
        } else if (hasPermission('VIEW_PRODUCTIVITY_QUALITY')) {
          setActivePage('productivityQuality');
        }
      }
    }
  }, [session, activePage, hasPermission, isMasterUser]);

  useEffect(() => {
    presenceManager.updateCurrentTab(activePage);
  }, [activePage]);

  // Tự đăng xuất sau 30 phút không thao tác (máy dùng chung ở xưởng).
  // 0đ, thuần client: server Supabase vẫn giữ JWT expiry riêng.
  useEffect(() => {
    if (!session) return;
    const TIMEOUT_MS = 30 * 60 * 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => logout(), TIMEOUT_MS);
    };
    const events = ['mousedown', 'keydown', 'touchstart', 'wheel'] as const;
    events.forEach((ev) => window.addEventListener(ev, reset, { passive: true }));
    reset();
    return () => {
      if (timer) clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, reset));
    };
  }, [session, logout]);

  if (!session) {
    return <LoginScreen />;
  }

  return (
    <Layout activePage={activePage} onSelectPage={setActivePage}>
      {activePage === 'dashboard' && <DashboardPage onNavigate={setActivePage} />}
      {activePage === 'employees' && <EmployeeListPage />}
      {activePage === 'timesheet' && <TimesheetCalendarPage onNavigate={setActivePage} />}
      {activePage === 'productivityQuality' && <ProductivityQualityPage />}
      {activePage === 'overtime' && <OvertimePage onNavigate={setActivePage} />}
      {activePage === 'leavePending' && <LeavePendingPage />}
      {activePage === 'shiftAssignment' && <ShiftAssignmentPage />}
      {activePage === 'attendanceViolation' && <AttendanceViolationPage />}
      {activePage === 'ocrVerification' && <OCRVerificationPage onNavigate={setActivePage} />}
      {activePage === 'userManagement' && (
        hasPermission('MANAGE_USERS') ? (
          <UserManagementPage />
        ) : (
          <div className="flex-1 p-8 flex flex-col items-center justify-center text-center">
            <div className="w-14 h-14 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center mb-4 border border-rose-200">
              <span className="text-2xl font-bold">🔒</span>
            </div>
            <h2 className="text-base font-bold text-slate-900">Quyền truy cập bị giới hạn</h2>
            <p className="text-xs text-slate-500 max-w-sm mt-2 leading-relaxed">
              Tài khoản của bạn không có quyền quản lý người dùng và xem nhật ký giao dịch của hệ thống.
            </p>
          </div>
        )
      )}
      {activePage === 'settings' && (
        hasPermission('SYSTEM_SETTINGS') ? (
          <SettingsPage />
        ) : (
          <div className="flex-1 p-8 flex flex-col items-center justify-center text-center">
            <div className="w-14 h-14 bg-rose-50 text-rose-600 rounded-2xl flex items-center justify-center mb-4 border border-rose-200">
              <span className="text-2xl font-bold">🔒</span>
            </div>
            <h2 className="text-base font-bold text-slate-900">Quyền truy cập bị giới hạn</h2>
            <p className="text-xs text-slate-500 max-w-sm mt-2 leading-relaxed">
              Tài khoản không được phép thao tác mục Cài đặt hệ thống. Vui lòng đăng nhập với tài khoản <b>Kieu(Mia)</b>, <b>Hoa(Molly)</b> hoặc <b>Glory(Software)</b>.
            </p>
            <button
              onClick={() => setActivePage('dashboard')}
              className="mt-4 px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-bold shadow-sm hover:bg-slate-800 transition"
            >
              Về Bảng điều khiển
            </button>
          </div>
        )
      )}
    </Layout>
  );
};

export const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <LanguageProvider>
          <ToastProvider>
            <ModalProvider>
              <Shell />
            </ModalProvider>
          </ToastProvider>
        </LanguageProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
};

export default App;
