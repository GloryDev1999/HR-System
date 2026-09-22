import React, { useEffect, useRef, useState } from 'react';
import {
  Upload,
  Globe,
  CheckCircle2,
  Loader2,
  ChevronDown,
  LogOut,
  UserCircle2,
  Bell,
  AlertTriangle,
  CalendarClock,
  Sparkles,
  KeyRound,
  X,
  Lock
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useToast } from '../../context/ToastContext';
import { useModal } from '../../context/ModalContext';
import { parseTimesheetFile } from '../../services/timesheet-parser-service';
import { reclassifySinglePunch } from '../../services/day-hours';
import { useLiveTable, listAll, bulkUpsert } from '../../lib/tables';
import { diffTimesheets, diffOvertimes, diffRawLogs, diffLeaves, type TsChange } from '../../services/import-diff';
import { daysUntil as calcDaysUntil } from '../../services/pay-period';
import { PresenceBar } from './PresenceBar';

export const Header: React.FC = () => {
  const { session, currentRole, hasPermission, logout, refreshPermissions } = useAuth();
  const { language, toggleLanguage, t } = useLanguage();
  const { success, error, warning, info } = useToast();
  const { alertModal, confirm } = useModal();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStatusText, setImportStatusText] = useState('');

  // Modal rà soát diff trước khi ghi (incremental, KB-028)
  const [diffReview, setDiffReview] = useState<null | {
    tsAdded: number;
    tsChanged: TsChange[];
    otAdded: number;
    otChanged: TsChange[];
    otPreserved: number;
    logsAdded: number;
    leavesAdded: number;
    resolve: (v: 'overwrite' | 'add-only' | null) => void;
  }>(null);

  const askDiffChoice = (summary: Omit<NonNullable<typeof diffReview>, 'resolve'>): Promise<'overwrite' | 'add-only' | null> => {
    return new Promise((resolve) => {
      setDiffReview({ ...summary, resolve });
    });
  };

  const decideDiff = (v: 'overwrite' | 'add-only' | null) => {
    diffReview?.resolve(v);
    setDiffReview(null);
  };
  const [isUserDropdownOpen, setIsUserDropdownOpen] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);

  // Chỉ riêng phòng Nhân sự (HR Manager / HR Admin) mới được xem thông báo hợp đồng
  const isHR = currentRole === 'HR Manager' || currentRole === 'HR Admin';

  // Chuông thông báo hợp đồng sắp hết hạn - Chỉ tính toán khi là HR
  const employees = useLiveTable('employees');
  const contractNotifs = isHR ? (() => {
    const now = new Date();
    const list: Array<{ emp: any; days: number; term: string; notifyAt: string }> = [];
    employees.forEach(emp => {
      if (!emp.contractEndDate || emp.status === 'RESIGNED') return;
      if (emp.contractTerm === 'PERMANENT') return;
      const days = calcDaysUntil(emp.contractEndDate, now);
      if (days === null || days < 0 || days > 30) return;
      // Ngưỡng thông báo chuẩn
      const term = emp.contractTerm;
      let shouldNotify = false;
      let notifyAt = '';
      if (term === '1_MONTH' || term === '2_MONTHS') {
        if (days <= 14 && days >= 12) { shouldNotify = true; notifyAt = '14 ngày'; }
        else if (days <= 7 && days >= 5) { shouldNotify = true; notifyAt = '7 ngày'; }
        else if (days <= 5 && days >= 0) { shouldNotify = true; notifyAt = `${days} ngày`; }
        else if (days <= 14 && days > 7) { shouldNotify = true; notifyAt = '14 ngày'; }
        else if (days <= 7) { shouldNotify = true; notifyAt = '7 ngày'; }
      } else if (term === '1_YEAR' || term === '3_YEARS') {
        if (days <= 30 && days > 15) { shouldNotify = true; notifyAt = '30 ngày'; }
        else if (days <= 15 && days >= 0) { shouldNotify = true; notifyAt = days <= 15 && days > 5 ? '15 ngày' : `${days} ngày`; }
      } else {
        // Chưa cấu hình term: nếu còn <=30 ngày thì báo
        if (days <= 30 && days >= 0) { shouldNotify = true; notifyAt = `${days} ngày`; }
      }
      if (shouldNotify) list.push({ emp, days, term: term || '—', notifyAt });
    });
    return list.sort((a,b) => a.days - b.days);
  })() : [];

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
      error('Định dạng tệp không hợp lệ', 'Vui lòng chọn tệp Excel (.xlsx hoặc .xls)');
      return;
    }

    try {
      setIsImporting(true);
      setImportProgress(5);
      setImportStatusText('Đang nạp và phân tích dữ liệu bảng công...');

      const buffer = await file.arrayBuffer();

      // Dữ liệu nạp vào kỳ hiện tại thay vì tháng cứng
      const now = new Date();
      const importMonth = now.getMonth() + 1;
      const importYear = now.getFullYear();

      const msg = await parseTimesheetFile(buffer, importMonth, importYear, (progress, message) => {
        setImportProgress(progress);
        setImportStatusText(message);
      });

      setImportProgress(40);
      setImportStatusText('[3/6] Nhận diện kỳ công & chuẩn bị dữ liệu...');

          // Nhận diện kỳ công
          const detectedMonth = msg.detectedPeriod?.month || importMonth;
          const detectedYear = msg.detectedPeriod?.year || importYear;
          try {
            localStorage.setItem('smarthr_selected_month', String(detectedMonth));
            localStorage.setItem('smarthr_selected_year', String(detectedYear));
            window.dispatchEvent(new CustomEvent('timesheet:period_changed', {
              detail: {
                month: detectedMonth,
                year: detectedYear,
                minDate: msg.detectedPeriod?.minDate,
                maxDate: msg.detectedPeriod?.maxDate
              }
            }));
          } catch {}

          setImportProgress(55);
          setImportStatusText('[4/6] Đối chiếu mã NV, ca làm việc & tính trạng thái công...');

          let postTimesheets: any[] = Array.isArray(msg.timesheets) ? [...msg.timesheets] : [];
          let postRawLogs: any[] = Array.isArray(msg.rawLogs) ? [...msg.rawLogs] : [];
          const overtimesToCreate: any[] = [];
          const leaveRequestsToCreate: any[] = [];
          const updatedRostersMap = new Map<string, any>();

          try {
            const employees = await listAll('employees');
            const shiftRosters = await listAll('shiftRosters');
            const empMap = new Map<string, any>(employees.map((e: any) => [e.employeeId.toUpperCase(), e]));
            const erpMap = new Map<string, any>(employees.filter((e: any) => e.erpId).map((e: any) => [String(e.erpId).trim(), e]));
            const shiftMap = new Map<string, any>(shiftRosters.map((r: any) => [r.employeeId_date, r]));
            for (const [k, v] of shiftMap.entries()) {
              updatedRostersMap.set(k, v);
            }

            // Helper nhận diện ca thực tế từ giờ quẹt thẻ chấm công
            const detectPunchShift = (checkIn: string, checkOut: string): { shiftCode: string; label: string; start: string; end: string } | null => {
              const inM = parseTimeToMinutes(checkIn);
              if (inM === null) return null;

              // Ca 2: 14:00 - 22:00 (vào từ 12:00 đến 17:00)
              if (inM >= 12 * 60 && inM <= 17 * 60) {
                return { shiftCode: 'SHIFT_2', label: 'Ca 2 (14:00 - 22:00)', start: '14:00', end: '22:00' };
              }

              // Ca 1: 06:00 - 14:00 (vào từ 04:30 đến 07:00)
              if (inM >= 4 * 60 + 30 && inM < 7 * 60) {
                return { shiftCode: 'SHIFT_1', label: 'Ca 1 (06:00 - 14:00)', start: '06:00', end: '14:00' };
              }

              // Vào từ 07:00 đến 10:00:
              // Nếu quẹt ra <= 14:45 -> Ca 1 trễ; Nếu quẹt ra > 14:45 -> Hành chính OFFICE_M_S
              const outM = parseTimeToMinutes(checkOut);
              if (outM !== null && outM <= 14 * 60 + 45) {
                return { shiftCode: 'SHIFT_1', label: 'Ca 1 (06:00 - 14:00)', start: '06:00', end: '14:00' };
              }
              return { shiftCode: 'OFFICE_M_S', label: 'HC (07:30 - 16:00)', start: '07:30', end: '16:00' };
            };

            // Helper tìm nhân viên linh hoạt theo employeeId, erpId, LEP000, LEP000Text
            const findEmployee = (rawId: string): any => {
              if (!rawId) return undefined;
              const clean = String(rawId).trim();
              const upper = clean.toUpperCase();
              if (empMap.has(upper)) return empMap.get(upper);
              if (erpMap.has(clean)) return erpMap.get(clean);
              const lepMatch = upper.match(/^LEP\s*0*(\d+)/i);
              if (lepMatch) {
                const num = parseInt(lepMatch[1], 10);
                const cand3 = `LEP${String(num).padStart(3, '0')}`;
                if (empMap.has(cand3)) return empMap.get(cand3);
                for (const emp of employees) {
                  const eNum = parseInt(emp.employeeId.replace(/\D/g, ''), 10);
                  if (eNum === num) return emp;
                }
              }
              if (/^\d+$/.test(clean)) {
                const num = parseInt(clean, 10);
                const cand3 = `LEP${String(num).padStart(3, '0')}`;
                if (empMap.has(cand3)) return empMap.get(cand3);
              }
              return undefined;
            };

            const parseTimeToMinutes = (t: string): number | null => {
              if (!t || typeof t !== 'string') return null;
              const p = t.trim().split(':');
              if (p.length < 2) return null;
              const h = parseInt(p[0], 10);
              const m = parseInt(p[1], 10);
              if (isNaN(h) || isNaN(m)) return null;
              return h * 60 + m;
            };

            // Xác định ca và ngày làm việc theo 4 nhóm ca
            const getShiftInfo = (emp: any, dateStr: string): {
              shiftCode: string;
              start: string;
              end: string;
              isWorkDay: boolean;
              isShift2: boolean;
            } => {
              const [yr, mo, da] = dateStr.split('-').map(Number);
              const dayOfWeek = new Date(yr, mo - 1, da).getDay(); // 0: CN, 1: T2.. 6: T7

              if (!emp) {
                return {
                  shiftCode: 'OFFICE_M_S',
                  start: '07:30',
                  end: '16:00',
                  isWorkDay: dayOfWeek !== 0,
                  isShift2: false
                };
              }

              // 1. Ưu tiên ca đã sắp xếp trong shiftRosters
              const key = `${emp.employeeId}_${dateStr}`;
              const roster = shiftMap.get(key);
              if (roster && roster.startTime && roster.endTime) {
                const isS2 = roster.shiftCode === 'SHIFT_2' || roster.startTime === '14:00';
                return {
                  shiftCode: roster.shiftCode || (isS2 ? 'SHIFT_2' : 'SHIFT_1'),
                  start: roster.startTime,
                  end: roster.endTime,
                  isWorkDay: dayOfWeek !== 0,
                  isShift2: isS2
                };
              }

              // 2. Nhóm ca mặc định theo danh sách nhân viên
              const sc = emp.shiftClassId as string;
              if (sc === 'OFFICE_M_F') {
                return {
                  shiftCode: 'OFFICE_M_F',
                  start: '07:30',
                  end: '16:00',
                  isWorkDay: dayOfWeek >= 1 && dayOfWeek <= 5, // T2 - T6
                  isShift2: false
                };
              }
              if (sc === 'SHIFT_1') {
                return {
                  shiftCode: 'SHIFT_1',
                  start: '06:00',
                  end: '14:00',
                  isWorkDay: dayOfWeek !== 0,
                  isShift2: false
                };
              }
              if (sc === 'SHIFT_2') {
                return {
                  shiftCode: 'SHIFT_2',
                  start: '14:00',
                  end: '22:00',
                  isWorkDay: dayOfWeek !== 0,
                  isShift2: true
                };
              }
              // Mặc định HC (OFFICE_M_S): T2-T7 (07:30 - 16:00)
              return {
                shiftCode: 'OFFICE_M_S',
                start: '07:30',
                end: '16:00',
                isWorkDay: dayOfWeek !== 0,
                isShift2: false
              };
            };

            // 1. Chuẩn hoá mã NV
            const unknownIds = new Set<string>();
            const remappedTimesheets: any[] = [];
            for (const ts of postTimesheets) {
              const rawEmpId = String(ts.employeeId || '').trim();
              const matchedEmp = findEmployee(rawEmpId);
              if (matchedEmp) {
                ts.employeeId = matchedEmp.employeeId;
                ts.employeeId_date = `${matchedEmp.employeeId}_${ts.date}`;
              } else {
                unknownIds.add(rawEmpId);
              }
              remappedTimesheets.push(ts);
            }
            postTimesheets = remappedTimesheets;

            const remappedRawLogs: any[] = [];
            for (const lg of postRawLogs) {
              const rawEmpId = String(lg.employeeId || '').trim();
              const matchedEmp = findEmployee(rawEmpId);
              if (matchedEmp) {
                lg.employeeId = matchedEmp.employeeId;
              } else {
                unknownIds.add(rawEmpId);
              }
              remappedRawLogs.push(lg);
            }
            postRawLogs = remappedRawLogs;

            if (unknownIds.size > 0) {
              warning(
                'Mã NV không khớp danh mục',
                `Có ${unknownIds.size} mã trong file chấm công không khớp Danh mục Nhân viên: ${Array.from(unknownIds).slice(0, 5).join(', ')}${unknownIds.size > 5 ? '...' : ''}.`
              );
            }

            setImportProgress(70);
            setImportStatusText('[5/6] Tính toán giờ tăng ca & kiểm soát vi phạm xoay ca 12h...');

            // 2. Đối chiếu giờ vào/ra với ca làm việc & tính toán trạng thái chuẩn
            for (const ts of postTimesheets) {
              const emp = empMap.get(String(ts.employeeId || '').toUpperCase());
              const shiftInfo = getShiftInfo(emp, ts.date);
              // Ô phép từ file nguồn (NGÀY NGHỈ PHÉP + PHÉP): giữ nguyên mã phép,
              // không tính lại thành OFF; yêu cầu chờ duyệt đã sinh ở parser (KB-027)
              if ((ts as any)._sourceLeave) continue;
              // QUY TẮC PUNCH ĐƠN (KB-027): máy dồn giờ chấm duy nhất vào cột Giờ vào.
              // Gốc LEP → ca cố định (shiftInfo đã ưu tiên sắp ca) → gần đầu ca là VÀO
              // (thiếu ra → MCO), gần cuối ca là RA (thiếu vào → MCI).
              let checkIn = String(ts.checkIn || '').trim();
              let checkOut = String(ts.checkOut || '').trim();
              if ((checkIn && !checkOut) || (!checkIn && checkOut)) {
                const fixed = reclassifySinglePunch(checkIn || checkOut, shiftInfo.start, shiftInfo.end);
                checkIn = fixed.checkIn;
                checkOut = fixed.checkOut;
                ts.checkIn = checkIn;
                ts.checkOut = checkOut;
              }

              const [yr, mo, da] = ts.date.split('-').map(Number);
              const dayOfWeek = new Date(yr, mo - 1, da).getDay(); // 0: CN, 1: T2.. 6: T7
              const isSunday = dayOfWeek === 0;

              // Gắn month & year chuẩn
              ts.month = detectedMonth;
              ts.year = detectedYear;

              // Kiểm tra đặc biệt 1: Nghỉ thai sản (ML)
              const isMaternity = emp?.status === 'MATERNITY' &&
                emp.maternityStartDate && emp.maternityEndDate &&
                ts.date >= emp.maternityStartDate && ts.date <= emp.maternityEndDate;

              if (isMaternity) {
                ts.statusCode = 'ML';
                ts.isViolation = false;
                ts.isViolationFlag = 0;
                ts.violationNote = 'Nghỉ thai sản (chế độ thai sản)';
                continue;
              }

              // Kiểm tra đặc biệt 2: Đi công tác ngoài (BT)
              const isBusinessTrip = emp?.businessTripStartDate && emp?.businessTripEndDate &&
                ts.date >= emp.businessTripStartDate && ts.date <= emp.businessTripEndDate;

              if (isBusinessTrip) {
                ts.statusCode = 'BT';
                ts.isViolation = false;
                ts.isViolationFlag = 0;
                ts.violationNote = emp.businessTripLocation ? `Đi công tác ngoài (${emp.businessTripLocation})` : 'Đi công tác ngoài (chế độ công tác)';
                continue;
              }

              // QUY TẮC NGÀY CHỦ NHẬT (SUNDAY):
              // "đối với ca làm việc ngày chủ nhật không tích chọn vào bảng chấm công mà tính thời gian tăng ca ở bảng Bảng Theo Dõi & Quản Lý Tăng Ca (Overtime Table) tính theo từ thời gian chấm công vào và ra ( nếu không chấm công ra và vào vẫn bị gắn cảnh báo MCI-MCO)"
              if (isSunday) {
                if (!checkIn && !checkOut) {
                  ts.statusCode = '';
                  ts.isViolation = false;
                  ts.isViolationFlag = 0;
                  ts.violationNote = undefined;
                } else if (checkIn && !checkOut) {
                  ts.statusCode = 'MCI';
                  ts.isViolation = true;
                  ts.isViolationFlag = 1;
                  ts.violationNote = `Chủ Nhật: Không chấm công ra (quẹt vào: ${checkIn})`;
                } else if (!checkIn && checkOut) {
                  ts.statusCode = 'MCO';
                  ts.isViolation = true;
                  ts.isViolationFlag = 1;
                  ts.violationNote = `Chủ Nhật: Không chấm công vào (quẹt ra: ${checkOut})`;
                } else {
                  // Có cả vào và ra: Không tích chọn trên bảng công, tính toàn bộ thời gian vào Bảng Tăng Ca
                  ts.statusCode = '';
                  ts.isViolation = false;
                  ts.isViolationFlag = 0;
                  ts.violationNote = 'Chủ Nhật: Tính tăng ca theo giờ quẹt vào/ra';

                  const inM = parseTimeToMinutes(checkIn)!;
                  const outM = parseTimeToMinutes(checkOut)!;
                  const sundayMinutes = Math.max(0, outM - inM);
                  if (sundayMinutes > 0) {
                    const sundayHours = +(sundayMinutes / 60).toFixed(2);
                    overtimesToCreate.push({
                      employeeId_date: `${ts.employeeId}_${ts.date}`,
                      employeeId: ts.employeeId,
                      date: ts.date,
                      dayOfWeek: 'CN',
                      hours: sundayHours,
                      rawMinutes: sundayMinutes,
                      dayType: 'SUNDAY',
                      verificationStatus: 'PENDING',
                      startTime: checkIn,
                      endTime: checkOut,
                      note: `Tăng ca Chủ Nhật: quẹt ${checkIn} → ${checkOut} (${sundayMinutes} phút = ${sundayHours}h)`,
                      month: detectedMonth,
                      year: detectedYear
                    });
                  }
                }
                continue;
              }

              // NGÀY LÀM VIỆC THƯỜNG (T2 - T7):
              // Trường hợp 1: Không chấm công cả vào lẫn ra
              if (!checkIn && !checkOut) {
                if (shiftInfo.isWorkDay) {
                  ts.statusCode = 'OFF';
                  ts.isViolation = false;
                  ts.isViolationFlag = 0;
                  ts.violationNote = 'Vắng không quẹt thẻ cả ngày (chờ bù phép)';

                  if (emp) {
                    leaveRequestsToCreate.push({
                      id: `LEAVE_${emp.employeeId}_${ts.date}`,
                      employeeId: emp.employeeId,
                      fullName: emp.fullName,
                      department: emp.department,
                      date: ts.date,
                      leaveType: 'AL',
                      durationDays: 1,
                      missedHours: 8,
                      workedHours: 0,
                      status: 'PENDING',
                      reason: 'Vắng không quẹt thẻ ngày làm việc'
                    });
                  }
                } else {
                  ts.statusCode = '';
                  ts.isViolation = false;
                  ts.isViolationFlag = 0;
                  ts.violationNote = undefined;
                }
                continue;
              }

              // Trường hợp 2: Thiếu 1 thời gian
              if (!checkIn && checkOut) {
                ts.statusCode = 'MCO';
                ts.isViolation = true;
                ts.isViolationFlag = 1;
                ts.violationNote = `Không chấm công vào (quẹt ra: ${checkOut} | ca ${shiftInfo.start}-${shiftInfo.end})`;
                continue;
              }
              if (checkIn && !checkOut) {
                ts.statusCode = 'MCI';
                ts.isViolation = true;
                ts.isViolationFlag = 1;
                ts.violationNote = `Không chấm công ra (quẹt vào: ${checkIn} | ca ${shiftInfo.start}-${shiftInfo.end})`;
                continue;
              }

              // Trường hợp 3: Cả vào và ra đều có quẹt thẻ
              const inMins = parseTimeToMinutes(checkIn)!;
              const outMins = parseTimeToMinutes(checkOut)!;
              const startMins = parseTimeToMinutes(shiftInfo.start)!;
              const endMins = parseTimeToMinutes(shiftInfo.end)!;

              // === TÍNH TOÁN TĂNG CA (OVERTIME) ===
              // 1. Quẹt vào sớm: Chỉ tính tăng ca nếu vào trong khung [start - 90', start - 60'] (ví dụ 6:00 - 6:30 đối với ca 7:30)
              // Sau 6:30 không tính tăng ca vào sớm
              const isEarlyInWindow = inMins >= (startMins - 90) && inMins <= (startMins - 60);
              const earlyOtMinutes = isEarlyInWindow ? Math.max(0, startMins - inMins) : 0;
              const isEarlyIn = earlyOtMinutes > 0;

              // 2. Làm thêm sau ca: quẹt ra sau giờ kết thúc ca
              const lateOtMinutes = outMins > endMins ? (outMins - endMins) : 0;

              // 3. Tổng thời gian tăng ca thực tế (không làm tròn)
              const totalOtMinutes = earlyOtMinutes + lateOtMinutes;
              if (totalOtMinutes > 0) {
                const otHours = +(totalOtMinutes / 60).toFixed(2);
                overtimesToCreate.push({
                  employeeId_date: `${ts.employeeId}_${ts.date}`,
                  employeeId: ts.employeeId,
                  date: ts.date,
                  dayOfWeek: ts.dayOfWeek || '',
                  hours: otHours,
                  rawMinutes: totalOtMinutes,
                  dayType: 'WEEKDAY',
                  verificationStatus: 'PENDING',
                  isEarlyIn,
                  startTime: isEarlyIn ? checkIn : shiftInfo.end,
                  endTime: checkOut,
                  note: isEarlyIn
                    ? `Vào sớm: ${earlyOtMinutes}p (khung 6h-6h30) + Sau ca: ${lateOtMinutes}p [Gắn cờ vào sớm]`
                    : `Làm thêm ${lateOtMinutes}p sau ca (${shiftInfo.end} → ${checkOut})`,
                  month: detectedMonth,
                  year: detectedYear
                });
              }

              // === TÍNH CÔNG & VI PHẠM (LA / ED / OFF) ===
              const late = inMins > startMins ? (inMins - startMins) : 0;
              const early = outMins < endMins ? (endMins - outMins) : 0;
              ts.lateMinutes = late;
              ts.earlyMinutes = early;

              if (late >= 60 || early >= 60) {
                ts.statusCode = 'OFF';
                ts.isViolation = true;
                ts.isViolationFlag = 1;

                const offMins = late >= 60 ? late : early;
                const missedHours = Math.min(8, Math.max(1, Math.ceil(offMins / 60)));
                const workedHours = Math.max(0, 8 - missedHours);

                ts.violationNote = late >= 60
                  ? `Đi trễ ${late} phút (≥ 60p) - vắng ${missedHours}h, làm việc ${workedHours}h (chờ bù phép)`
                  : `Về sớm ${early} phút (≥ 60p) - vắng ${missedHours}h, làm việc ${workedHours}h (chờ bù phép)`;

                if (emp) {
                  leaveRequestsToCreate.push({
                    id: `LEAVE_${emp.employeeId}_${ts.date}`,
                    employeeId: emp.employeeId,
                    fullName: emp.fullName,
                    department: emp.department,
                    date: ts.date,
                    leaveType: 'AL',
                    durationDays: missedHours / 8,
                    missedHours: missedHours,
                    workedHours: workedHours,
                    status: 'PENDING',
                    reason: late >= 60
                      ? `Đi trễ ${late} phút (≥ 60p) - vắng ${missedHours}h, làm ${workedHours}h`
                      : `Về sớm ${early} phút (≥ 60p) - vắng ${missedHours}h, làm ${workedHours}h`
                  });
                }
              } else if (late >= 2) {
                ts.statusCode = 'LA';
                ts.isViolation = true;
                ts.isViolationFlag = 1;
                ts.violationNote = `Đi làm trễ ${late} phút (LA) - ca ${shiftInfo.start} | vào ${checkIn}`;
              } else if (early >= 2) {
                ts.statusCode = 'ED';
                ts.isViolation = true;
                ts.isViolationFlag = 1;
                ts.violationNote = `Về sớm ${early} phút (ED) - ca ${shiftInfo.end} | ra ${checkOut}`;
              } else {
                ts.statusCode = shiftInfo.isShift2 ? 'N' : 'W';
                ts.isViolation = false;
                ts.isViolationFlag = 0;
                ts.violationNote = undefined;
              }
            }

            // === 2.5 ĐỐI CHIẾU CA SẮP XẾP VS CHẤM CÔNG THỰC TẾ (CẢNH BÁO ĐI SAI GIỜ SẮP CA) ===
            for (const ts of postTimesheets) {
              const emp = empMap.get(String(ts.employeeId || '').toUpperCase());
              // Miễn trừ tuyệt đối khối hành chính văn phòng OFFICE_M_F (23 công)
              if (emp?.shiftClassId === 'OFFICE_M_F') continue;

              const checkIn = String(ts.checkIn || '').trim();
              const checkOut = String(ts.checkOut || '').trim();
              if (!checkIn) continue;

              const rosterKey = `${ts.employeeId}_${ts.date}`;
              let roster = updatedRostersMap.get(rosterKey);
              const shiftInfo = getShiftInfo(emp, ts.date);
              const detectedShift = detectPunchShift(checkIn, checkOut);

              const scheduledShift = roster?.shiftCode || shiftInfo.shiftCode;
              const isEligibleDept = ['Production', 'QC', 'WH'].includes(emp?.department || '');

              const isShiftMismatch = Boolean(
                detectedShift &&
                scheduledShift &&
                detectedShift.shiftCode !== scheduledShift &&
                (Boolean(roster) || isEligibleDept)
              );

              let mismatchDetails: string | undefined;
              if (isShiftMismatch && detectedShift) {
                const scheduledLabel = scheduledShift === 'SHIFT_1' ? 'Ca 1 (06:00-14:00)' : scheduledShift === 'SHIFT_2' ? 'Ca 2 (14:00-22:00)' : 'HC (07:30-16:00)';
                mismatchDetails = `Đi sai giờ sắp ca: Sắp ${scheduledLabel}, thực tế đi ${detectedShift.label} (vào ${checkIn}${checkOut ? ', ra ' + checkOut : ''})`;

                ts.isViolation = true;
                ts.isViolationFlag = 1;
                ts.violationNote = ts.violationNote
                  ? `${ts.violationNote} | Đi sai ca (Sắp ${scheduledShift}, đi ${detectedShift.shiftCode})`
                  : `Đi sai ca (Sắp ${scheduledShift}, thực tế đi ${detectedShift.shiftCode})`;
              }

              if (roster) {
                roster.actualCheckIn = checkIn;
                roster.actualCheckOut = checkOut;
                roster.actualShiftCode = detectedShift?.shiftCode;
                roster.isShiftMismatch = isShiftMismatch;
                roster.isShiftMismatchFlag = isShiftMismatch ? 1 : 0;
                roster.mismatchDetails = mismatchDetails;
                updatedRostersMap.set(rosterKey, roster);
              } else if (isShiftMismatch && detectedShift) {
                updatedRostersMap.set(rosterKey, {
                  employeeId_date: rosterKey,
                  employeeId: ts.employeeId,
                  fullName: emp?.fullName || ts.employeeId,
                  department: emp?.department || '',
                  date: ts.date,
                  shiftCode: scheduledShift,
                  startTime: shiftInfo.start,
                  endTime: shiftInfo.end,
                  actualCheckIn: checkIn,
                  actualCheckOut: checkOut,
                  actualShiftCode: detectedShift.shiftCode,
                  isShiftMismatch: true,
                  isShiftMismatchFlag: 1,
                  mismatchDetails,
                  isRestViolation: false,
                  isRestViolationFlag: 0,
                  restHours: 16
                });
              }
            }

            // === 3. KIỂM TRA VI PHẠM XOAY CA KHÔNG NGHỈ ĐỦ 12 TIẾNG (12h Rest Rule - LỰA CHỌN A) ===
            const empTimesheetMap = new Map<string, any[]>();
            for (const ts of postTimesheets) {
              const list = empTimesheetMap.get(ts.employeeId) || [];
              list.push(ts);
              empTimesheetMap.set(ts.employeeId, list);
            }

            for (const [empId, list] of empTimesheetMap.entries()) {
              list.sort((a, b) => a.date.localeCompare(b.date));
              const emp = empMap.get(empId.toUpperCase());
              if (emp?.shiftClassId === 'OFFICE_M_F') continue; // Miễn trừ HC văn phòng

              for (let idx = 0; idx < list.length - 1; idx++) {
                const curTs = list[idx];
                const nextTs = list[idx + 1];

                const curDate = new Date(curTs.date);
                const nextDate = new Date(nextTs.date);
                const diffTime = nextDate.getTime() - curDate.getTime();
                const diffDays = Math.round(diffTime / (1000 * 3600 * 24));

                if (diffDays === 1) {
                  const curShift = getShiftInfo(emp, curTs.date);
                  const nextShift = getShiftInfo(emp, nextTs.date);

                  // Lựa chọn A: Tính theo giờ quẹt thẻ thực tế (fallback về ca chuẩn nếu thiếu)
                  const curEndStr = curTs.checkOut || curShift.end;
                  const nextStartStr = nextTs.checkIn || nextShift.start;

                  const curEndMins = parseTimeToMinutes(curEndStr);
                  const nextStartMins = parseTimeToMinutes(nextStartStr);

                  if (curEndMins !== null && nextStartMins !== null) {
                    const restMins = (24 * 60 - curEndMins) + nextStartMins;
                    const restHours = +(restMins / 60).toFixed(1);

                    if (restMins < 12 * 60) {
                      const nextRosterKey = `${empId}_${nextTs.date}`;
                      const existingRoster = updatedRostersMap.get(nextRosterKey);
                      const violationNote = `Nghỉ ${restHours}h giữa 2 ca liên tiếp (${curEndStr} → ${nextStartStr}) < 12h theo Luật LĐ & L&P`;

                      if (existingRoster) {
                        existingRoster.previousShiftEndTime = curEndStr;
                        existingRoster.restHours = restHours;
                        existingRoster.isRestViolation = true;
                        existingRoster.isRestViolationFlag = 1;
                        existingRoster.violationDetails = violationNote;
                        updatedRostersMap.set(nextRosterKey, existingRoster);
                      } else {
                        updatedRostersMap.set(nextRosterKey, {
                          employeeId_date: nextRosterKey,
                          employeeId: empId,
                          fullName: emp?.fullName || empId,
                          department: emp?.department || '',
                          date: nextTs.date,
                          shiftCode: nextShift.shiftCode,
                          previousShiftEndTime: curEndStr,
                          startTime: nextStartStr,
                          endTime: nextTs.checkOut || nextShift.end,
                          restHours: restHours,
                          isRestViolation: true,
                          violationDetails: violationNote,
                          isShiftMismatch: false,
                        });
                      }

                      nextTs.isViolation = true;
                      nextTs.violationNote = nextTs.violationNote
                        ? `${nextTs.violationNote} | Vi phạm nghỉ < 12h (${restHours}h)`
                        : `Vi phạm nghỉ < 12h giữa 2 ca (${restHours}h)`;
                    }
                  }
                }
              }
            }

          } catch (postErr: any) {
            console.error('Post-process timesheet error:', postErr);
            warning('Lưu ý xử lý hậu kỳ', postErr.message || 'Lỗi khi đối chiếu ca/phép, vẫn tiến hành lưu dữ liệu.');
          }

          setImportProgress(90);
          setImportStatusText('[6/7] So sánh với dữ liệu hệ thống...');

          // Rà soát diff incremental (KB-028): KHÔNG xóa toàn bảng nữa.
          // Thêm mới + thay đổi + khớp (bỏ qua); thời vụ theo timeline 1-31 riêng
          // nhờ khóa theo ngày, không ép vào khung 21-20.
          const [existingTS, existingOT, existingLogs, existingLeaves] = await Promise.all([
            listAll('dailyTimesheets'),
            listAll('overtimeRecords'),
            listAll('rawAttendanceLogs'),
            listAll('leaveRequests'),
          ]);
          const tsDiff = diffTimesheets(existingTS, postTimesheets);
          const otDiff = diffOvertimes(existingOT, overtimesToCreate);
          const logsAdded = diffRawLogs(existingLogs, postRawLogs);
          const leavesAdded = diffLeaves(existingLeaves, [...leaveRequestsToCreate, ...(msg.leaves || [])]);

          const totalNew = tsDiff.added.length + otDiff.added.length + logsAdded.length + leavesAdded.length;
          const totalChanged = tsDiff.changed.length + otDiff.changed.length;

          if (totalNew === 0 && totalChanged === 0) {
            setImportProgress(100);
            setIsImporting(false);
            info('Dữ liệu khớp 100%', 'File nguồn khớp hoàn toàn dữ liệu hệ thống — không có gì để cập nhật.');
            return;
          }

          const choice = await askDiffChoice({
            tsAdded: tsDiff.added.length,
            tsChanged: tsDiff.changed,
            otAdded: otDiff.added.length,
            otChanged: otDiff.changed,
            otPreserved: otDiff.preserved,
            logsAdded: logsAdded.length,
            leavesAdded: leavesAdded.length,
          });
          if (!choice) {
            setIsImporting(false);
            info('Đã hủy cập nhật', 'Dữ liệu hệ thống được giữ nguyên 100%.');
            return;
          }

          setImportProgress(95);
          setImportStatusText('[7/7] Ghi lên Supabase...');

          // Ghi incremental tuần tự (mỗi op nguyên tử phía server).
          // KHÔNG clear shiftRosters để bảo toàn dữ liệu sắp ca!
          const tsToWrite = choice === 'overwrite'
            ? [...tsDiff.added, ...tsDiff.changed.map(c => c.record)]
            : tsDiff.added;
          const otToWrite = choice === 'overwrite'
            ? [...otDiff.added, ...otDiff.changed.map(c => c.record)]
            : otDiff.added;
          if (tsToWrite.length > 0) {
            await bulkUpsert('dailyTimesheets', tsToWrite);
          }
          if (otToWrite.length > 0) {
            await bulkUpsert('overtimeRecords', otToWrite);
          }
          if (logsAdded.length > 0) {
            await bulkUpsert('rawAttendanceLogs', logsAdded);
          }
          if (leavesAdded.length > 0) {
            await bulkUpsert('leaveRequests', leavesAdded);
          }
          const rostersToSave = Array.from(updatedRostersMap.values());
          if (rostersToSave.length > 0) {
            await bulkUpsert('shiftRosters', rostersToSave as any);
          }

          const allRosters = Array.from(updatedRostersMap.values());
          const restViolationCount = allRosters.filter((r: any) => r.isRestViolation).length;
          const mismatchCount = allRosters.filter((r: any) => r.isShiftMismatch).length;

          setImportProgress(100);
          setIsImporting(false);
          success(
            'Nạp dữ liệu chấm công thành công!',
            `Đã thêm ${totalNew.toLocaleString()} mới${choice === 'overwrite' ? ` + ghi đè ${totalChanged.toLocaleString()} thay đổi` : ` (bỏ qua ${totalChanged.toLocaleString()} thay đổi)`}${otDiff.preserved > 0 ? `, giữ ${otDiff.preserved} OT đã đối soát` : ''}. ${restViolationCount} cảnh báo nghỉ < 12h, ${mismatchCount} cảnh báo đi sai ca.`
          );
    } catch (err: any) {
      setIsImporting(false);
      error('Lỗi hệ thống', err.message);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between sticky top-0 z-30 shadow-sm">
      {/* Left: Logo + Nút Thư Mục Signaling + Nút Kết Nối 1-Chạm + Chuông thông báo hợp đồng (Chỉ HR) */}
      <div className="flex items-center gap-2.5 flex-1 max-w-2xl">
        <img
          src="./Leggett.jpg"
          alt="Leggett & Platt HOME FURNITURE"
          className="h-9 w-auto object-contain max-w-[200px]"
          loading="eager"
        />

        {/* Chuông thông báo hợp đồng sắp hết hạn - CHỈ HIỂN THỊ VỚI PHÒNG NHÂN SỰ (HR) */}
        {isHR && (
          <div className="relative">
            <button
              onClick={() => setIsNotifOpen(v => !v)}
              className="relative p-2.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-xl transition shadow-sm"
              title="Thông báo hợp đồng sắp hết hạn"
              aria-label="Thông báo hợp đồng"
            >
              <Bell className="w-5 h-5 text-slate-700" />
              {contractNotifs.length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 bg-rose-600 text-white text-[10px] font-black rounded-full flex items-center justify-center border-2 border-white shadow">
                  {contractNotifs.length}
                </span>
              )}
            </button>
            {isNotifOpen && (
              <div className="absolute left-0 mt-2 w-[380px] bg-white rounded-2xl shadow-xl border border-slate-200 py-2 z-50 animate-in fade-in zoom-in-95 overflow-hidden">
                <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                  <div className="font-extrabold text-slate-900 text-xs flex items-center gap-2">
                    <CalendarClock className="w-4 h-4 text-amber-600" />
                    <span>Hợp đồng sắp hết hạn</span>
                    <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[10px]">{contractNotifs.length} nhân viên</span>
                  </div>
                  <button onClick={() => setIsNotifOpen(false)} className="text-slate-400 hover:text-slate-600 text-xs">×</button>
                </div>
                <div className="max-h-[320px] overflow-y-auto">
                  {contractNotifs.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500">
                      <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-500 mb-2" />
                      <p className="font-semibold text-slate-700">Không có hợp đồng sắp hết hạn</p>
                      <p className="text-[11px] text-slate-400 mt-1">Ngưỡng: HĐ 1-2 tháng → 14 & 7 ngày | HĐ 1/3 năm → 30 & 15 ngày | Vĩnh viễn không báo</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {contractNotifs.map(({ emp, days, term }) => (
                        <div key={emp.employeeId} className="px-4 py-3 hover:bg-slate-50 flex items-start justify-between gap-3">
                          <div className="flex-1">
                            <div className="font-bold text-slate-900 text-xs">{emp.employeeId} • {emp.fullName}</div>
                            <div className="text-[11px] text-slate-500">{emp.department} • {emp.position} • {term === '1_MONTH' ? 'HĐ 1 tháng' : term === '2_MONTHS' ? 'HĐ 2 tháng' : term === '1_YEAR' ? 'HĐ 1 năm' : term === '3_YEARS' ? 'HĐ 3 năm' : term === 'PERMANENT' ? 'Vĩnh viễn' : 'Chưa cấu hình'} {emp.contractEndDate ? `• hết hạn ${emp.contractEndDate}` : ''}</div>
                          </div>
                          <span className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-black border ${days <= 5 ? 'bg-rose-100 text-rose-700 border-rose-200 animate-pulse' : days <= 15 ? 'bg-amber-100 text-amber-700 border-amber-200' : 'bg-blue-100 text-blue-700 border-blue-200'}`}>
                            còn {days} ngày
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Right: Actions, Import/Export, Language & Role Switcher */}
      <div className="flex items-center gap-3">
        {/* Hidden File Input */}
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".xlsx, .xls"
          className="hidden"
        />

        {/* Import Button - đã đổi thành Nạp dữ liệu chấm công */}
        {hasPermission('IMPORT_LOGS') && (
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
            className="flex items-center gap-2 px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition shadow-sm disabled:opacity-60"
            title="Nạp dữ liệu chấm công"
          >
            {isImporting ? (
              <Loader2 className="w-4 h-4 animate-spin text-orange-500" />
            ) : (
              <Upload className="w-4 h-4 text-slate-600" />
            )}
            <span className="hidden lg:inline">{isImporting ? `${importProgress}%` : t('importExcel')}</span>
          </button>
        )}

        {/* Realtime Active Avatars */}
        <PresenceBar />

        {/* Language Toggle Button */}
        <button
          onClick={toggleLanguage}
          className="flex items-center gap-1.5 px-3 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 text-xs font-bold rounded-xl transition"
          title="Chuyển đổi ngôn ngữ Tiếng Việt / English"
        >
          <Globe className="w-4 h-4 text-slate-500" />
          <span className="uppercase">{language}</span>
        </button>

        {/* User Menu (thay cho role-switcher: vai trò đến từ tài khoản đăng nhập) */}
        <div className="relative">
          <button
            onClick={() => setIsUserDropdownOpen(v => !v)}
            aria-haspopup="menu"
            aria-expanded={isUserDropdownOpen}
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium rounded-xl transition shadow-sm"
          >
            <UserCircle2 className="w-4 h-4 text-orange-400" />
            <span>{session?.displayName ?? 'Chưa đăng nhập'}</span>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
          </button>

          {isUserDropdownOpen && (
            <div
              role="menu"
              className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-xl border border-slate-100 py-1.5 z-50 animate-in fade-in zoom-in-95"
            >
              <div className="px-3 py-1.5 text-[11px] font-bold text-slate-400 uppercase tracking-wider border-b border-slate-100">
                {session?.username} · {currentRole}
              </div>
              <button
                role="menuitem"
                onClick={() => {
                  setIsUserDropdownOpen(false);
                  setIsChangePasswordOpen(true);
                }}
                className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-slate-700 hover:bg-slate-50 transition font-semibold border-b border-slate-100"
              >
                <KeyRound className="w-3.5 h-3.5 text-orange-500" />
                <span>Đổi mật khẩu</span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setIsUserDropdownOpen(false);
                  logout();
                  info('Đã đăng xuất', 'Hẹn gặp lại!');
                }}
                className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-rose-600 hover:bg-rose-50 transition font-semibold"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Đăng xuất</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Streaming Import Progress Modal (0% - 100%) */}
      {isImporting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100 flex flex-col items-center text-center space-y-4">
            <div className="relative flex items-center justify-center">
              <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-orange-500 to-rose-500 flex items-center justify-center shadow-lg shadow-orange-500/30">
                <Loader2 className="w-8 h-8 text-white animate-spin" />
              </div>
            </div>

            <div>
              <h3 className="text-base font-bold text-slate-900">
                Đang Xử Lý & Tính Toán Dữ Liệu Chấm Công
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                {importStatusText}
              </p>
            </div>

            {/* Progress bar */}
            <div className="w-full space-y-1.5">
              <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden border border-slate-200 p-0.5">
                <div
                  className="bg-gradient-to-r from-orange-500 via-rose-500 to-pink-500 h-full rounded-full transition-all duration-300 shadow-sm"
                  style={{ width: `${importProgress}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[11px] font-bold">
                <span className="text-slate-400">Tiến độ phân tích & đối soát</span>
                <span className="text-orange-600 font-mono text-xs">{importProgress}%</span>
              </div>
            </div>

            <div className="w-full p-3 bg-slate-50 rounded-2xl border border-slate-200 text-left text-[11px] text-slate-500 space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-slate-700">
                <Sparkles className="w-3.5 h-3.5 text-orange-500" />
                <span>Quy trình tự động thực hiện:</span>
              </div>
              <div className="text-[10px] text-slate-500 space-y-0.5 pl-4">
                <div>• Nhận diện kỳ công & làm sạch bảng công cũ</div>
                <div>• Đối chiếu ca làm việc, tính công (W/N/OFF) & vi phạm (LA/ED/MCI/MCO)</div>
                <div>• Tính giờ tăng ca thực tế & gắn cờ vào sớm (khung 6h-6h30)</div>
                <div>• Kiểm soát vi phạm xoay ca không nghỉ đủ 12 tiếng</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal rà soát diff trước khi cập nhật (incremental, KB-028) */}
      {diffReview && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-md animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-2xl w-full p-6 shadow-2xl border border-slate-100 max-h-[90vh] flex flex-col">
            <h3 className="text-base font-bold text-slate-900 pb-3 border-b border-slate-100">
              Rà soát trước khi cập nhật
            </h3>
            <div className="py-4 space-y-3 text-xs overflow-y-auto">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-center">
                  <div className="text-lg font-extrabold text-emerald-700">{diffReview.tsAdded + diffReview.otAdded + diffReview.logsAdded + diffReview.leavesAdded}</div>
                  <div className="font-semibold text-emerald-800">Dòng mới</div>
                </div>
                <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-center">
                  <div className="text-lg font-extrabold text-amber-700">{diffReview.tsChanged.length + diffReview.otChanged.length}</div>
                  <div className="font-semibold text-amber-800">Dòng thay đổi</div>
                </div>
                <div className="p-2.5 rounded-xl bg-sky-50 border border-sky-200 text-center">
                  <div className="text-lg font-extrabold text-sky-700">{diffReview.leavesAdded}</div>
                  <div className="font-semibold text-sky-800">Chờ bù phép mới</div>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-center">
                  <div className="text-lg font-extrabold text-slate-700">{diffReview.otPreserved}</div>
                  <div className="font-semibold text-slate-600">OT đã duyệt (giữ)</div>
                </div>
              </div>
              {(diffReview.tsChanged.length + diffReview.otChanged.length) > 0 ? (
                <div>
                  <div className="font-bold text-slate-700 mb-1.5">
                    Chi tiết thay đổi (ô công + tăng ca) — tối đa 200 dòng đầu:
                  </div>
                  <div className="max-h-64 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
                    {[...diffReview.tsChanged, ...diffReview.otChanged].slice(0, 200).map((c, i) => (
                      <div key={i} className="px-3 py-1.5">
                        <span className="font-mono font-bold text-slate-800">{c.record.employeeId} • {c.record.date}</span>
                        {c.conflicts.map((cf, j) => (
                          <div key={j} className="text-slate-600">
                            {cf.field}: <s className="text-slate-400">{cf.oldVal || '∅'}</s>
                            <span className="mx-1 text-slate-400">→</span>
                            <b className="text-orange-600">{cf.newVal || '∅'}</b>
                          </div>
                        ))}
                      </div>
                    ))}
                    {(diffReview.tsChanged.length + diffReview.otChanged.length) > 200 && (
                      <div className="px-3 py-1.5 text-slate-400 italic">
                        …và {(diffReview.tsChanged.length + diffReview.otChanged.length) - 200} dòng nữa
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-slate-500">Không có ô nào thay đổi — chỉ thêm dòng mới.</p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-100 flex-wrap">
              <button
                onClick={() => decideDiff(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition"
              >
                Hủy bỏ
              </button>
              <button
                onClick={() => decideDiff('add-only')}
                className="px-4 py-2 text-xs font-bold text-sky-700 bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-xl transition"
              >
                Chỉ thêm mới ({diffReview.tsAdded + diffReview.otAdded + diffReview.logsAdded + diffReview.leavesAdded})
              </button>
              <button
                onClick={() => decideDiff('overwrite')}
                className="px-4 py-2 text-xs font-bold text-white bg-orange-500 hover:bg-orange-600 rounded-xl shadow-md shadow-orange-200 transition"
              >
                Ghi đè + thêm mới ({diffReview.tsChanged.length + diffReview.otChanged.length} thay đổi)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change Password Modal */}
      {isChangePasswordOpen && (
        <ChangePasswordModal
          isOpen={isChangePasswordOpen}
          onClose={() => setIsChangePasswordOpen(false)}
        />
      )}
    </header>
  );
};

const ChangePasswordModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const { changePassword, session } = useAuth();
  const { success, error, warning } = useToast();
  const [currentPass, setCurrentPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPass || !newPass || !confirmPass) {
      warning('Thiếu thông tin', 'Vui lòng điền đầy đủ các trường.');
      return;
    }
    if (newPass.length < 3) {
      warning('Mật khẩu quá ngắn', 'Mật khẩu mới phải có tối thiểu 3 ký tự.');
      return;
    }
    if (newPass !== confirmPass) {
      warning('Không trùng khớp', 'Mật khẩu xác nhận không khớp với mật khẩu mới.');
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await changePassword(currentPass, newPass);
      if (res.ok) {
        success('Đổi mật khẩu thành công', 'Mật khẩu tài khoản của bạn đã được cập nhật.');
        onClose();
        setCurrentPass('');
        setNewPass('');
        setConfirmPass('');
      } else {
        error('Đổi mật khẩu thất bại', res.error || 'Vui lòng kiểm tra lại mật khẩu hiện tại.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-orange-100 text-orange-700 rounded-xl">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-extrabold text-slate-900 text-base">Đổi Mật Khẩu</h3>
              <p className="text-xs text-slate-500">Tài khoản: <b className="text-slate-800">{session?.displayName}</b> ({session?.username})</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Mật khẩu hiện tại *</label>
            <input
              type="password"
              value={currentPass}
              onChange={(e) => setCurrentPass(e.target.value)}
              placeholder="••••••••"
              className="w-full px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 text-xs"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Mật khẩu mới *</label>
            <input
              type="password"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              placeholder="Tối thiểu 3 ký tự"
              className="w-full px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 text-xs"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Xác nhận mật khẩu mới *</label>
            <input
              type="password"
              value={confirmPass}
              onChange={(e) => setConfirmPass(e.target.value)}
              placeholder="Nhập lại mật khẩu mới"
              className="w-full px-3 py-2 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500 text-xs"
              required
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl transition"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-400 text-white font-bold text-xs rounded-xl shadow-sm transition flex items-center gap-1.5"
            >
              {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
              <span>Cập Nhật Mật Khẩu</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
