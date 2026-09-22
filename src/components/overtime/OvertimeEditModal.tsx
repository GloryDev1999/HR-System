import React, { useState } from 'react';
import { Clock, X } from 'lucide-react';
import { upsertOne } from '../../lib/tables';
import type { IEmployee, IOvertimeRecord, OvertimeVerificationStatus } from '../../types';
import type { CalendarDay } from '../../services/calendar-utils';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';

interface OvertimeEditModalProps {
  employee: IEmployee;
  day: CalendarDay;
  /** Bản ghi OT hiện có, hoặc bản ghi trống do caller dựng khi thêm mới thủ công */
  otRecord: IOvertimeRecord;
  /** true khi thêm mới (chưa tồn tại trong DB) */
  isNew: boolean;
  onClose: () => void;
}

/**
 * Modal Chi Tiết Tăng Ca — dùng chung cho OvertimePage và Bảng chấm công (cột OT).
 * Logic giữ nguyên: xem/sửa giờ OT, làm tròn thủ công, đổi trạng thái đối soát, ghi chú.
 */
export const OvertimeEditModal: React.FC<OvertimeEditModalProps> = ({
  employee,
  day,
  otRecord,
  isNew,
  onClose,
}) => {
  const { success, error } = useToast();
  const { hasPermission } = useAuth();
  const canManageOt = hasPermission('MANAGE_OT') || hasPermission('PROPOSE_DEPT_OT');

  const [hours, setHours] = useState<number>(otRecord.hours);
  const [note, setNote] = useState<string>(otRecord.note || '');
  const [verificationStatus, setVerificationStatus] = useState<OvertimeVerificationStatus>(
    otRecord.verificationStatus
  );

  const handleSave = async () => {
    if (!canManageOt) {
      error('Không đủ quyền', 'Bạn không có quyền lưu giờ tăng ca.');
      return;
    }
    try {
      const updated: IOvertimeRecord = {
        ...otRecord,
        hours: Number(hours),
        note: note.trim(),
        verificationStatus,
        verifiedAt: new Date().toISOString(),
      };

      if (updated.hours <= 0 && isNew) {
        onClose();
        return;
      }

      await upsertOne('overtimeRecords', updated);
      success('Đã lưu tăng ca', `Đã cập nhật ${updated.hours}h tăng ca cho ${employee.fullName}`);
      onClose();
    } catch (err: any) {
      error('Lỗi khi lưu tăng ca', err.message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in">
      <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-orange-500" />
            <h3 className="text-base font-bold text-slate-900">Chi Tiết Tăng Ca (Overtime)</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs space-y-1.5">
          <div>Nhân viên: <b className="text-slate-900">{employee.fullName}</b> ({employee.employeeId})</div>
          <div>Ngày: <b>{day.dayVi}, {day.dateStr}</b> ({day.isSunday ? 'Chủ Nhật' : 'Ngày thường'})</div>
          {otRecord.startTime && otRecord.endTime ? (
            <div>Khung giờ: <b>{otRecord.startTime} → {otRecord.endTime}</b></div>
          ) : null}
          <div>Số phút quẹt thẻ thực tế: <b>{otRecord.rawMinutes || Math.round(otRecord.hours * 60)} phút</b></div>
          {otRecord.isEarlyIn && (
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
              value={hours}
              onChange={(e) => setHours(parseFloat(e.target.value) || 0)}
              className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm font-bold text-orange-600 focus:outline-none focus:border-orange-500"
            />
            <span className="text-xs font-semibold text-slate-500">giờ</span>
          </div>

          {/* Quick round helpers */}
          <div className="flex items-center gap-1.5 mt-2">
            <span className="text-[11px] text-slate-400">Làm tròn nhanh:</span>
            <button
              type="button"
              onClick={() => setHours(Math.round(hours))}
              className="px-2 py-0.5 text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition"
            >
              Về chẵn (.0)
            </button>
            <button
              type="button"
              onClick={() => setHours(Math.round(hours * 2) / 2)}
              className="px-2 py-0.5 text-[11px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition"
            >
              Về nửa giờ (.5)
            </button>
            {otRecord.rawMinutes ? (
              <button
                type="button"
                onClick={() => setHours(+(otRecord.rawMinutes! / 60).toFixed(2))}
                className="px-2 py-0.5 text-[11px] font-semibold bg-orange-50 hover:bg-orange-100 text-orange-700 rounded-lg transition"
              >
                Thực tế ({+(otRecord.rawMinutes / 60).toFixed(2)}h)
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
              onClick={() => setVerificationStatus('PENDING')}
              className={`p-2 rounded-xl text-xs font-bold border transition text-center ${
                verificationStatus === 'PENDING'
                  ? 'bg-amber-500 text-white border-amber-500 shadow-md'
                  : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
              }`}
            >
              Chờ xác nhận
            </button>
            <button
              type="button"
              onClick={() => setVerificationStatus('MATCHED')}
              className={`p-2 rounded-xl text-xs font-bold border transition text-center ${
                verificationStatus === 'MATCHED'
                  ? 'bg-emerald-600 text-white border-emerald-600 shadow-md'
                  : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
              }`}
            >
              Đã khớp OCR
            </button>
            <button
              type="button"
              onClick={() => setVerificationStatus('MISMATCH')}
              className={`p-2 rounded-xl text-xs font-bold border transition text-center ${
                verificationStatus === 'MISMATCH'
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
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Nhập ghi chú hoặc lý do điều chỉnh..."
            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:border-orange-500 resize-none"
          />
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
          >
            Hủy bỏ
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="px-4 py-2 text-xs font-bold text-white bg-orange-500 hover:bg-orange-600 rounded-xl shadow-md shadow-orange-200 transition"
          >
            Lưu thay đổi
          </button>
        </div>
      </div>
    </div>
  );
};
