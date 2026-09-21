import React, { useState } from 'react';
import { 
  CalendarCheck, 
  Search, 
  CheckCircle, 
  XCircle, 
  AlertTriangle, 
  Calendar, 
  Clock, 
  FileText,
  ShieldAlert,
  ArrowRight,
  Filter
} from 'lucide-react';
import { useLiveTable, getByKey, upsertOne, updateByKey } from '../lib/tables';
import type { IEmployee, IDailyTimesheetCell, ILeaveRequest, LeaveType, AttendanceStatusCode } from '../types';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';
import { useAuth } from '../context/AuthContext';

export const LeavePendingPage: React.FC = () => {
  const { success, warning, error } = useToast();
  const { alertModal, confirm } = useModal();
  const { departmentScope, hasPermission, session, currentRole } = useAuth();

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDept, setSelectedDept] = useState<string>('ALL');
  const [selectedLeaveType, setSelectedLeaveType] = useState<Record<string, LeaveType>>({});
  const [selectedHours, setSelectedHours] = useState<Record<string, number>>({});

  // Live queries (Supabase realtime)
  const employees = useLiveTable<IEmployee>('employees');
  const pendingRequests = useLiveTable<ILeaveRequest>('leaveRequests');
  const timesheets = useLiveTable<IDailyTimesheetCell>('dailyTimesheets');

  // Filter pending requests
  const filteredRequests = pendingRequests.filter(req => {
    if (departmentScope && req.department !== departmentScope) return false;
    if (selectedDept !== 'ALL' && req.department !== selectedDept) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const m1 = req.employeeId.toLowerCase().includes(q);
      const m2 = req.fullName.toLowerCase().includes(q);
      if (!m1 && !m2) return false;
    }
    return true;
  });

  const departments = Array.from(new Set(employees.map(e => e.department))).filter(Boolean);

  // Handle approving leave compensation (yêu cầu quyền MANAGE_LEAVE)
  const handleApproveLeave = async (req: ILeaveRequest, chosenType: LeaveType) => {
    if (!hasPermission('MANAGE_LEAVE')) {
      error('Không đủ quyền', 'Bạn không có quyền phê duyệt nghỉ phép (MANAGE_LEAVE).');
      return;
    }
    const emp = employees.find(e => e.employeeId === req.employeeId);
    if (!emp) {
      error('Không tìm thấy nhân viên', `Mã NV: ${req.employeeId}`);
      return;
    }

    // Tính số giờ phép và giờ làm
    const defaultHours = req.missedHours ?? (req.durationDays < 1 ? Math.round(req.durationDays * 8) : 8);
    const leaveHours = selectedHours[req.id] ?? defaultHours;
    const workHours = Math.max(0, 8 - leaveHours);
    const effectiveDurationDays = leaveHours / 8; // e.g. 2h / 8 = 0.25 công

    // ANNUAL LEAVE QUOTA ENFORCEMENT - kiểm tra trước để báo UI thân thiện
    if (chosenType === 'AL') {
      const remainingQuota = emp.annualLeaveBalance?.remainingDays ?? 0;
      if (remainingQuota < effectiveDurationDays) {
        await alertModal(
          'Từ Chối Phê Duyệt Phép Năm (Hết Hạn Mức)',
          (
            <div className="space-y-2">
              <p className="text-slate-800 font-semibold">
                Nhân viên <span className="text-orange-600 font-bold">[{emp.employeeId}] {emp.fullName}</span> hiện chỉ còn <span className="text-rose-600 font-bold">{remainingQuota}</span> ngày phép năm trong hồ sơ.
              </p>
              <p className="text-slate-600 text-xs">
                Yêu cầu bù phép {effectiveDurationDays} ngày ({leaveHours} giờ phép năm) đã bị từ chối do vượt quá hạn mức còn lại. Vui lòng chọn loại nghỉ <b>Không Lương (UL)</b> hoặc điều chỉnh hạn mức phép trong Menu Danh Mục Nhân Viên.
              </p>
            </div>
          ),
          'danger'
        );
        return;
      }
    }

    // Xác định mã công: nếu < 8 tiếng thì chia theo dạng W{workHours}/{chosenType}{leaveHours} (VD: W6/AL2)
    let newStatusCode: AttendanceStatusCode = 'UL';
    if (leaveHours >= 8) {
      newStatusCode = chosenType;
    } else {
      newStatusCode = `W${workHours}/${chosenType}${leaveHours}`;
    }

    // Update Timesheet cell - kỳ lấy từ ngày yêu cầu thay vì tháng cứng
    const cellKey = `${req.employeeId}_${req.date}`;
    const [y, m] = req.date.split('-').map(Number);

    try {
      // Phê duyệt: chuỗi ghi Supabase tuần tự (mỗi op nguyên tử phía server)
      const freshEmp = await getByKey<IEmployee>('employees', req.employeeId);
      if (!freshEmp) throw new Error(`Nhân viên ${req.employeeId} vừa bị xoá khỏi hệ thống`);

      if (chosenType === 'AL') {
        const remainingQuota = freshEmp.annualLeaveBalance?.remainingDays ?? 0;
        if (remainingQuota < effectiveDurationDays) {
          throw new Error(`Hạn mức phép năm chỉ còn ${remainingQuota} ngày - không đủ ${effectiveDurationDays} ngày`);
        }
        await updateByKey('employees', req.employeeId, {
          annualLeaveBalance: {
            ...freshEmp.annualLeaveBalance,
            usedDays: (freshEmp.annualLeaveBalance?.usedDays ?? 0) + effectiveDurationDays,
            remainingDays: Math.max(0, remainingQuota - effectiveDurationDays)
          }
        });
      }

      const existingCell = await getByKey<IDailyTimesheetCell>('dailyTimesheets', cellKey);

      await upsertOne('dailyTimesheets', {
        employeeId_date: cellKey,
        employeeId: req.employeeId,
        date: req.date,
        dayIndex: parseInt(req.date.split('-')[2], 10),
        statusCode: newStatusCode,
        calculatedOvertime: existingCell?.calculatedOvertime || 0,
        checkIn: existingCell?.checkIn,
        checkOut: existingCell?.checkOut,
        isViolation: false,
        violationNote: leaveHours < 8
          ? `Bù phép ${leaveHours} giờ (${chosenType}) + làm việc ${workHours} giờ (W)`
          : `Đã duyệt bù phép cả ngày (${chosenType})`,
        month: m,
        year: y
      });

      await updateByKey('leaveRequests', req.id, {
        status: 'APPROVED',
        leaveType: chosenType,
        durationDays: effectiveDurationDays,
        missedHours: leaveHours,
        workedHours: workHours,
        processedBy: session?.displayName ?? currentRole ?? 'unknown',
        processedAt: new Date().toISOString()
      });
    } catch (e: any) {
      error('Phê duyệt thất bại', e?.message || String(e));
      return;
    }

    success(
      'Phê duyệt bù phép thành công!',
      `Đã chuyển trạng thái ngày ${req.date} của ${emp.fullName} sang mã "${newStatusCode}" (Làm ${workHours}h / Nghỉ ${leaveHours}h).`
    );
  };

  // Reject / mark unauthorized (yêu cầu quyền MANAGE_LEAVE)
  const handleRejectLeave = async (req: ILeaveRequest) => {
    if (!hasPermission('MANAGE_LEAVE')) {
      error('Không đủ quyền', 'Bạn không có quyền xử lý nghỉ phép (MANAGE_LEAVE).');
      return;
    }
    const ok = await confirm({
      title: 'Xác nhận ghi nhận Không Phép',
      message: `Bạn có chắc chắn muốn ghi nhận vi phạm nghỉ không phép cho nhân viên [${req.employeeId}] ${req.fullName} vào ngày ${req.date}?`,
      type: 'warning',
      confirmText: 'Xác nhận vi phạm',
      cancelText: 'Hủy'
    });

    if (ok) {
      const cellKey = `${req.employeeId}_${req.date}`;
      const [y, m] = req.date.split('-').map(Number);
      try {
        const existingCell = await getByKey<IDailyTimesheetCell>('dailyTimesheets', cellKey);
        await upsertOne('dailyTimesheets', {
          employeeId_date: cellKey,
          employeeId: req.employeeId,
          date: req.date,
          dayIndex: parseInt(req.date.split('-')[2], 10),
          statusCode: 'Off',
          calculatedOvertime: existingCell?.calculatedOvertime || 0,
          checkIn: existingCell?.checkIn,
          checkOut: existingCell?.checkOut,
          isViolation: true,
          violationNote: 'Từ chối bù phép - ghi nhận không phép (Off)',
          month: m,
          year: y
        });
        await updateByKey('leaveRequests', req.id, {
          status: 'REJECTED',
          rejectionReason: 'Vắng mặt không phép vi phạm nội quy'
        });
        success('Đã ghi nhận không phép', `Đã cập nhật ngày ${req.date} của ${req.fullName} thành "Off" (nghỉ không phép).`);
      } catch (err: any) {
        error('Xử lý thất bại', err?.message || String(err));
      }
    }
  };

  return (
    <div className="p-6 w-full space-y-6 flex-1 flex flex-col">
      {/* Top Banner */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <CalendarCheck className="w-5 h-5 text-orange-500" />
            <span>Danh Sách Chờ Bù Phép & Ràng Buộc Hạn Mức (Pending Leave)</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Thu gom tự động các trường hợp nhân viên không chấm công vào/ra trong ngày làm việc quy định (đánh dấu "Off" ở bảng công). Kiểm tra số dư phép năm thực tế trước khi phê duyệt.
          </p>
        </div>

        <div className="px-3.5 py-2 rounded-xl bg-orange-50 text-orange-800 border border-orange-200 text-xs font-bold flex items-center gap-2">
          <Clock className="w-4 h-4 text-orange-600" />
          <span>{filteredRequests.filter(r => r.status === 'PENDING').length} trường hợp cần xử lý</span>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-3 w-full sm:w-auto flex-1 max-w-md">
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
            className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-orange-500"
          >
            <option value="ALL">Tất cả Phòng Ban</option>
            {departments.map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex-1">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
              <tr>
                <th className="py-3 px-4">#</th>
                <th className="py-3 px-4">Mã NV & Họ Tên</th>
                <th className="py-3 px-4">Bộ Phận</th>
                <th className="py-3 px-4 text-center">Ngày Vắng Mặt</th>
                <th className="py-3 px-4 text-center">Số Dư Phép Năm</th>
                <th className="py-3 px-4 text-center">Loại Nghỉ Bù Đề Xuất</th>
                <th className="py-3 px-4 text-center">Trạng Thái</th>
                <th className="py-3 px-4 text-right">Phê Duyệt & Chốt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRequests.map((req, idx) => {
                const emp = employees.find(e => e.employeeId === req.employeeId);
                const remainingAL = emp?.annualLeaveBalance?.remainingDays ?? 0;
                const chosenType = selectedLeaveType[req.id] || req.leaveType || 'AL';

                return (
                  <tr key={req.id} className="hover:bg-slate-50/80 transition">
                    <td className="py-3 px-4 text-slate-400 font-semibold">{idx + 1}</td>
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-900">{req.fullName}</div>
                      <div className="text-[11px] text-slate-400 font-mono">{req.employeeId}</div>
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-700">{req.department}</td>
                    <td className="py-3 px-4 text-center font-bold text-rose-600">
                      <span className="px-2.5 py-1 rounded-lg bg-rose-50 border border-rose-200 block">
                        {req.date}
                      </span>
                      <span className="text-[10px] text-slate-500 font-normal mt-0.5 block">
                        {req.missedHours && req.missedHours < 8
                          ? `Vắng ${req.missedHours}h / 8h (${req.missedHours / 8} ngày)`
                          : `${req.durationDays || 1} ngày`}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      <span className={`px-2 py-0.5 rounded-full font-bold text-[11px] ${
                        remainingAL <= 0
                          ? 'bg-rose-100 text-rose-700 border border-rose-200'
                          : 'bg-blue-100 text-blue-800'
                      }`}>
                        {remainingAL} ngày còn lại
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center">
                      {req.status === 'PENDING' ? (
                        <div className="flex flex-col items-center gap-1.5 min-w-[210px]">
                          <select
                            value={chosenType}
                            onChange={(e) => setSelectedLeaveType({ ...selectedLeaveType, [req.id]: e.target.value as LeaveType })}
                            className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-orange-500"
                          >
                            <option value="AL">Phép năm (AL) - Trừ số dư</option>
                            <option value="UL">Nghỉ không lương (UL)</option>
                            <option value="SL">Nghỉ ốm / bệnh (SL)</option>
                            <option value="PL">Nghỉ chế độ: tang/cưới (PL)</option>
                          </select>

                          {/* Custom giờ bù phép khi vắng dưới 1 ngày */}
                          {(() => {
                            const curLeaveH = selectedHours[req.id] ?? (req.missedHours ?? (req.durationDays < 1 ? Math.round(req.durationDays * 8) : 8));
                            const curWorkH = Math.max(0, 8 - curLeaveH);
                            return (
                              <div className="w-full flex flex-col gap-1 bg-slate-50 p-1.5 rounded-lg border border-slate-200 text-left">
                                <div className="flex items-center justify-between text-[11px]">
                                  <span className="text-slate-500 font-medium">Giờ bù phép:</span>
                                  <select
                                    value={curLeaveH}
                                    onChange={(e) => setSelectedHours({ ...selectedHours, [req.id]: parseInt(e.target.value, 10) })}
                                    className="px-1.5 py-0.5 bg-white border border-slate-300 rounded text-xs font-bold text-slate-800"
                                  >
                                    <option value={1}>1h phép (Làm 7h - W7/{chosenType}1)</option>
                                    <option value={2}>2h phép (Làm 6h - W6/{chosenType}2)</option>
                                    <option value={3}>3h phép (Làm 5h - W5/{chosenType}3)</option>
                                    <option value={4}>4h phép (Làm 4h - W4/{chosenType}4)</option>
                                    <option value={5}>5h phép (Làm 3h - W3/{chosenType}5)</option>
                                    <option value={6}>6h phép (Làm 2h - W2/{chosenType}6)</option>
                                    <option value={7}>7h phép (Làm 1h - W1/{chosenType}7)</option>
                                    <option value={8}>8h (Cả ngày - {chosenType})</option>
                                  </select>
                                </div>
                                <div className="text-center pt-0.5 border-t border-slate-200/60">
                                  <span className="inline-block px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-blue-50 text-blue-700 border border-blue-200">
                                    {curLeaveH < 8 ? `Chốt ô công: W${curWorkH}/${chosenType}${curLeaveH}` : `Chốt ô công: ${chosenType}`}
                                  </span>
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      ) : (
                        <div className="font-bold text-slate-700 text-xs">
                          {req.leaveType}
                          {req.missedHours && req.missedHours < 8 && (
                            <div className="text-[10px] font-mono text-blue-600">
                              W{req.workedHours ?? (8 - req.missedHours)}/{req.leaveType}{req.missedHours}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center">
                      {req.status === 'PENDING' && (
                        <span className="px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 font-bold text-[11px] inline-flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                          Chờ duyệt
                        </span>
                      )}
                      {req.status === 'APPROVED' && (
                        <span className="px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[11px] inline-flex items-center gap-1">
                          <CheckCircle className="w-3 h-3 text-emerald-600" />
                          Đã duyệt
                        </span>
                      )}
                      {req.status === 'REJECTED' && (
                        <span className="px-2.5 py-1 rounded-full bg-rose-100 text-rose-800 font-bold text-[11px] inline-flex items-center gap-1">
                          <XCircle className="w-3 h-3 text-rose-600" />
                          Từ chối
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {req.status === 'PENDING' && (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleApproveLeave(req, chosenType)}
                            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg transition shadow-sm shadow-emerald-200"
                          >
                            Duyệt
                          </button>
                          <button
                            onClick={() => handleRejectLeave(req)}
                            className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold rounded-lg transition"
                          >
                            Từ chối
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filteredRequests.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-400">
                    <CheckCircle className="w-8 h-8 mx-auto text-emerald-500 mb-2 opacity-80" />
                    <p className="font-semibold text-slate-600">Không có trường hợp vắng mặt nào đang chờ bù phép.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
