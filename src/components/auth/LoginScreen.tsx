import React, { useState } from 'react';
import { Lock, User, LogIn, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { useAuth, DEFAULT_ADMIN_USERNAME } from '../../context/AuthContext';

export const LoginScreen: React.FC = () => {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const res = await login(username, password);
      if (!res.ok) setError(res.error || 'Đăng nhập thất bại');
    } catch (err: any) {
      setError(err?.message || 'Lỗi không xác định');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-br from-slate-100 via-slate-50 to-orange-50 p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-3xl shadow-xl border border-slate-200 overflow-hidden">
          {/* Header */}
          <div className="px-8 pt-8 pb-6 text-center border-b border-slate-100">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-slate-900 flex items-center justify-center mb-4 shadow-lg">
              <ShieldCheck className="w-8 h-8 text-orange-400" />
            </div>
            <h1 className="text-xl font-extrabold text-slate-900">SmartHR - Leggett &amp; Platt</h1>
            <p className="text-xs text-slate-500 mt-1">Hệ thống chấm công &amp; quản trị nhân sự</p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-8 py-6 space-y-4">
            <div>
              <label htmlFor="login-username" className="block text-xs font-bold text-slate-600 mb-1.5">
                Tên đăng nhập
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  id="login-username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="ví dụ: admin"
                  className="w-full pl-9 pr-3 py-2.5 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-400/60 focus:border-orange-400 transition"
                />
              </div>
            </div>

            <div>
              <label htmlFor="login-password" className="block text-xs font-bold text-slate-600 mb-1.5">
                Mật khẩu
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full pl-9 pr-10 py-2.5 text-sm border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-400/60 focus:border-orange-400 transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="px-3 py-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold" role="alert">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-400 text-white text-sm font-bold rounded-xl transition shadow-md"
            >
              {isSubmitting ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  <span>Đang kiểm tra...</span>
                </>
              ) : (
                <>
                  <LogIn className="w-4 h-4 text-orange-400" />
                  <span>Đăng Nhập</span>
                </>
              )}
            </button>

            {/* Quick Login buttons */}
            <div className="pt-2 border-t border-slate-100">
              <p className="text-[11px] font-bold text-slate-500 mb-2 text-center">
                Chọn tài khoản kiểm tra phân quyền:
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setUsername('vinh');
                    setPassword('123');
                  }}
                  className="px-2.5 py-2 bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 rounded-xl text-left transition cursor-pointer"
                >
                  <div className="font-bold text-xs">👤 Vinh</div>
                  <div className="text-[10px] text-purple-600">Admin system (123)</div>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setUsername('kieu');
                    setPassword('123');
                  }}
                  className="px-2.5 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-xl text-left transition cursor-pointer"
                >
                  <div className="font-bold text-xs">👤 Kiều</div>
                  <div className="text-[10px] text-blue-600">HR manager (123)</div>
                </button>
              </div>
            </div>

            <div className="text-center text-[10px] text-slate-400 leading-relaxed">
              • <b>Vinh (123)</b>: Toàn quyền hệ thống &amp; Cài đặt RBAC
              <br />• <b>Kiều (123)</b>: Toàn quyền nhân sự (không vào Cài đặt)
            </div>
          </form>
        </div>

        <p className="text-center text-[10px] text-slate-400 mt-4">
          Xác thực qua Supabase Auth. Nhập username (vd: kieu) hoặc full email (kieu@hr.os).
        </p>
      </div>
    </div>
  );
};
