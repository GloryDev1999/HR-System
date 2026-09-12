import React, { useEffect, useRef, useState } from 'react';
import {
  Upload,
  Download,
  Globe,
  CheckCircle2,
  Loader2,
  FileSpreadsheet,
  ChevronDown,
  Cloud,
  LogOut,
  UserCircle2,
  Bell,
  AlertTriangle,
  CalendarClock,
  Sparkles,
  Radio,
  Server,
  Wifi,
  WifiOff,
  KeyRound,
  X,
  Lock,
  Folder,
  Link2,
  Copy,
  Check
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { useToast } from '../../context/ToastContext';
import { useModal } from '../../context/ModalContext';
import { exportTimesheetToExcel } from '../../services/excel-exporter';
import { exportDatabaseToSnapshot, importDatabaseFromSnapshot } from '../../services/db-sync';
import { db } from '../../db';
import { parseTimesheetFile } from '../../services/timesheet-parser-service';
import { useLiveQuery } from 'dexie-react-hooks';
import { daysUntil as calcDaysUntil } from '../../services/pay-period';
import { PresenceBar } from './PresenceBar';
import { clusterService } from '../../services/webrtc-cluster-service';
import { folderSignaling } from '../../services/folder-signaling-service';
import { NodeConnectionStatus } from '../../types/cluster';

export const Header: React.FC = () => {
  const { session, currentRole, hasPermission, logout, refreshPermissions, departmentScope } = useAuth();
  const { language, toggleLanguage, t } = useLanguage();
  const { success, error, warning, info } = useToast();
  const { alertModal, confirm } = useModal();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStatusText, setImportStatusText] = useState('');
  const [isUserDropdownOpen, setIsUserDropdownOpen] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false);

  // Chỉ riêng phòng Nhân sự (HR Manager / HR Admin) mới được xem thông báo hợp đồng
  const isHR = currentRole === 'HR Manager' || currentRole === 'HR Admin';

  // Quản trị trạng thái Cụm Mạng P2P WebRTC (Star-Topology)
  const [clusterStatus, setClusterStatus] = useState<NodeConnectionStatus>(() => clusterService.getStatus());
  
  // Quản lý Thư Mục Tín Hiệu WebRTC (HR_Signaling_Data trên OneDrive)
  const [hasFolderHandle, setHasFolderHandle] = useState(() => folderSignaling.hasDirectoryHandle());
  const [isFolderGranted, setIsFolderGranted] = useState(() => folderSignaling.isPermissionGranted());
  const [folderName, setFolderName] = useState(() => folderSignaling.getFolderName());
  const [isFolderModalOpen, setIsFolderModalOpen] = useState(false);
  const [folderHostCheck, setFolderHostCheck] = useState<{ online: boolean; hostInfo?: any; lastSeen?: number } | null>(null);
  const [modalTab, setModalTab] = useState<'folder' | 'token'>('folder');
  const [pairClientId, setPairClientId] = useState('CLIENT_01');
  const [generatedPairToken, setGeneratedPairToken] = useState('');
  const [inputPairToken, setInputPairToken] = useState('');
  const [isPairWorking, setIsPairWorking] = useState(false);
  const [hasCopiedPairToken, setHasCopiedPairToken] = useState(false);

  useEffect(() => {
    return folderSignaling.onStatusChange((has, name, isGranted) => {
      setHasFolderHandle(has);
      setFolderName(name);
      setIsFolderGranted(isGranted);
    });
  }, []);

  // Xác định chính xác quyền Host: Mặc định là 'kieu' (hoặc 'glory' nếu được cấu hình trong Cài Đặt)
  // Các tài khoản trạm (vinh, nguyetanh, han, hoa...) tuyệt đối không bị nhận nhầm làm Host
  const isClusterHost = session ? (
    session.username.toLowerCase() === 'kieu' ||
    (session.username.toLowerCase() === 'glory' && clusterService.isHostConfigured())
  ) : false;

  useEffect(() => {
    return clusterService.onStatusChange((status) => {
      setClusterStatus(status);
    });
  }, []);

  // Tự động kích hoạt: Kieu tự động host Master DB; Máy trạm tự động tìm kiếm kết nối tới Kieu
  useEffect(() => {
    if (session) {
      if (isClusterHost) {
        clusterService.quickStartAsHost().catch(console.error);
      } else {
        // Tự động kết nối 1-chạm tới Host Kiều khi đăng nhập máy trạm
        clusterService.quickConnectAsClient(session.username, session.displayName).catch(console.error);
      }
    }
  }, [session, isClusterHost]);

  const handlePickOrGrantFolder = async () => {
    try {
      let ok = false;
      if (hasFolderHandle && !isFolderGranted) {
        ok = await folderSignaling.requestPermission();
      } else {
        ok = await folderSignaling.pickDirectory();
      }

      if (ok) {
        success('Đã cấp quyền thư mục', `Đã liên kết thành công với thư mục "${folderSignaling.getFolderName()}".`);
        if (isClusterHost) {
          clusterService.quickStartAsHost().catch(console.error);
        } else if (session) {
          clusterService.quickConnectAsClient(session.username, session.displayName).catch(console.error);
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        error('Lỗi chọn thư mục', err.message || 'Không thể liên kết thư mục.');
      }
    }
  };

  const handleOpenFolderModal = async () => {
    const check = await folderSignaling.checkHostStatus();
    setFolderHostCheck(check);
    setIsFolderModalOpen(true);
  };

  const handleOneTouchConnect = async () => {
    if (!session) return;

    // Hỗ trợ tự động cấp quyền thư mục HR_Signaling_Data nếu chưa cấp
    if (folderSignaling.isSupported() && (!folderSignaling.hasDirectoryHandle() || !folderSignaling.isPermissionGranted())) {
      try {
        const ok = await folderSignaling.requestPermission();
        if (ok) {
          success('Đã cấp quyền thư mục', `Đã liên kết HR_Signaling_Data. File JSON tín hiệu sẽ tự động trao đổi qua OneDrive.`);
        }
      } catch (err) {
        console.warn('Chưa cấp quyền thư mục:', err);
      }
    }

    if (isClusterHost) {
      await clusterService.quickStartAsHost();
      success('Host Master DB đang hoạt động', 'Máy chủ Kieu sẵn sàng tiếp nhận kết nối RTCDataChannel.');
    } else {
      await clusterService.quickConnectAsClient(session.username, session.displayName);
      info('Đang kết nối tới Host Kiều', `Máy trạm ${session.displayName} đang phát tín hiệu bắt tay qua mạng P2P...`);
    }
  };

  // Chuông thông báo hợp đồng sắp hết hạn - Chỉ tính toán khi là HR
  const employees = useLiveQuery(() => db.employees.toArray(), []) || [];
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
          const restViolationsToCreate: any[] = [];
          const leaveRequestsToCreate: any[] = [];

          try {
            const employees = await db.employees.toArray();
            const shiftRosters = await db.shiftRosters.toArray();
            const empMap = new Map<string, any>(employees.map((e: any) => [e.employeeId.toUpperCase(), e]));
            const erpMap = new Map<string, any>(employees.filter((e: any) => e.erpId).map((e: any) => [String(e.erpId).trim(), e]));
            const shiftMap = new Map<string, any>(shiftRosters.map((r: any) => [r.employeeId_date, r]));

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
              const checkIn = String(ts.checkIn || '').trim();
              const checkOut = String(ts.checkOut || '').trim();

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
                      restViolationsToCreate.push({
                        employeeId_date: `${empId}_${nextTs.date}`,
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
                        isRestViolationFlag: 1,
                        violationDetails: `Nghỉ ${restHours}h giữa 2 ca liên tiếp (${curEndStr} → ${nextStartStr}) < 12h theo Luật LĐ & L&P`
                      });
                    }
                  }
                }
              }
            }

          } catch (postErr: any) {
            console.error('Post-process timesheet error:', postErr);
            warning('Lưu ý xử lý hậu kỳ', postErr.message || 'Lỗi khi đối chiếu ca/phép, vẫn tiến hành lưu dữ liệu.');
          }

          for (const ts of postTimesheets) {
            if (typeof ts.isViolationFlag === 'undefined') ts.isViolationFlag = ts.isViolation ? 1 : 0;
          }

          setImportProgress(90);
          setImportStatusText('[6/6] Ghi vào cơ sở dữ liệu Dexie.js (IndexedDB)...');

          // Thực hiện làm sạch và ghi mới trong MỘT Transaction nguyên tử (ACID)
          // Đảm bảo không bao giờ bị mất dữ liệu cũ nếu gặp lỗi giữa chừng
          await db.transaction('rw', [db.dailyTimesheets, db.overtimeRecords, db.rawAttendanceLogs, db.leaveRequests, db.shiftRosters], async () => {
            await db.dailyTimesheets.clear();
            await db.overtimeRecords.clear();
            await db.rawAttendanceLogs.clear();
            await db.leaveRequests.clear();
            await db.shiftRosters.clear();

            if (postTimesheets.length > 0) {
              await db.dailyTimesheets.bulkPut(postTimesheets);
            }
            if (overtimesToCreate.length > 0) {
              await db.overtimeRecords.bulkPut(overtimesToCreate);
            }
            if (postRawLogs.length > 0) {
              await db.rawAttendanceLogs.bulkAdd(postRawLogs);
            }
            if (leaveRequestsToCreate.length > 0) {
              await db.leaveRequests.bulkPut(leaveRequestsToCreate);
            }
            if (restViolationsToCreate.length > 0) {
              await db.shiftRosters.bulkPut(restViolationsToCreate);
            }
          });

          setImportProgress(100);
          setIsImporting(false);
          success(
            'Nạp dữ liệu chấm công thành công!',
            `Đã làm sạch bảng công cũ và cập nhật ${postTimesheets.length.toLocaleString()} ô công, ${overtimesToCreate.length.toLocaleString()} bản ghi tăng ca, ${restViolationsToCreate.length} cảnh báo xoay ca < 12h.`
          );
    } catch (err: any) {
      setIsImporting(false);
      error('Lỗi hệ thống', err.message);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleExportExcel = async () => {
    try {
      info('Đang chuẩn bị dữ liệu xuất Excel...', 'Hệ thống đang định dạng tiêu đề, chèn logo Leggett & Platt và áp dụng công thức.');
      const emps = await db.employees.toArray();
      const timesheets = await db.dailyTimesheets.toArray();
      const overtimes = await db.overtimeRecords.toArray();

      const savedMonth = localStorage.getItem('smarthr_selected_month');
      const savedYear = localStorage.getItem('smarthr_selected_year');
      const now = new Date();
      const curMonth = savedMonth ? parseInt(savedMonth, 10) : (now.getMonth() + 1);
      const curYear = savedYear ? parseInt(savedYear, 10) : now.getFullYear();

      const exportEmps = departmentScope ? emps.filter(e => e.department === departmentScope) : emps;

      if (exportEmps.length === 0) {
        warning('Chưa có dữ liệu nhân viên để xuất tệp.');
        return;
      }

      // Lấy settings hiện tại để truyền vào exporter (công thức custom)
      let settings: any = undefined;
      try {
        const raw = localStorage.getItem('smarthr_settings');
        if (raw) settings = JSON.parse(raw);
        const dex = await db.settings.get('systemSettings');
        if (dex?.value) settings = dex.value;
      } catch {}
      await exportTimesheetToExcel(exportEmps, timesheets, overtimes, curMonth, curYear, 'ALL', settings);
      success('Xuất file Excel thành công!', `Đã xuất ${exportEmps.length} NV kỳ ${curMonth}/${curYear} (Chính thức 21-20 + Thời vụ 1-31, 2 sheet nếu có đủ nhóm).`);
    } catch (err: any) {
      error('Lỗi xuất Excel', err.message);
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

        {/* Nút Chọn & Quản lý Thư Mục HR_Signaling_Data / Ghép Nối Mã Offline */}
        {folderSignaling.isSupported() ? (
          !hasFolderHandle ? (
            <button
              onClick={handlePickOrGrantFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-600 text-white shadow-sm border border-amber-400 animate-pulse transition shrink-0"
              title="Nhấn để chọn thư mục HR_Signaling_Data (OneDrive) để đồng bộ mạng P2P với Host Kiều"
            >
              <Folder className="w-3.5 h-3.5" />
              <span>📁 Chọn HR_Signaling_Data</span>
            </button>
          ) : !isFolderGranted ? (
            <button
              onClick={handlePickOrGrantFolder}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-amber-100 hover:bg-amber-200 text-amber-900 border border-amber-300 shadow-sm transition shrink-0"
              title="Trình duyệt cần bạn bấm để cấp quyền đọc/ghi thư mục HR_Signaling_Data"
            >
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 animate-bounce" />
              <span>Cấp Quyền {folderName || 'Thư Mục'}</span>
            </button>
          ) : (
            <button
              onClick={handleOpenFolderModal}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 shadow-xs transition shrink-0"
              title="Thư mục tín hiệu WebRTC P2P đã sẵn sàng. Bấm để xem thông tin hoặc đổi thư mục."
            >
              <Folder className="w-3.5 h-3.5 text-amber-500" />
              <span className="font-mono text-[11px] max-w-[120px] truncate">{folderName || 'HR_Signaling_Data'}</span>
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
            </button>
          )
        ) : (
          <button
            onClick={() => {
              setModalTab('token');
              handleOpenFolderModal();
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 shadow-xs transition shrink-0"
            title="Đang mở trực tiếp file://. Bấm để mở hộp thoại Ghép Nối Bằng Mã Offline (không cần web server)"
          >
            <Link2 className="w-3.5 h-3.5 text-indigo-600" />
            <span>Ghép Nối Mã Offline</span>
          </button>
        )}

        {/* Nút Kết Nối 1-Chạm (1-Touch WebRTC Cluster Connect) */}
        {isClusterHost ? (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs font-bold shadow-sm shrink-0">
            <span className={`w-2 h-2 rounded-full ${clusterStatus === 'CONNECTED' ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse`} />
            <Server className="w-3.5 h-3.5 text-orange-600" />
            <span>{clusterStatus === 'CONNECTED' ? 'Host Master DB (Đang Phục Vụ)' : 'Host Master DB (Sẵn Sàng)'}</span>
          </div>
        ) : (
          <button
            onClick={handleOneTouchConnect}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-xs font-bold transition shadow-sm border shrink-0 ${
              clusterStatus === 'CONNECTED'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                : clusterStatus === 'SIGNALING'
                ? 'bg-indigo-50 text-indigo-700 border-indigo-200 animate-pulse'
                : clusterStatus === 'HOST_OFFLINE'
                ? 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100'
                : 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white border-orange-400'
            }`}
            title="Kết nối thời gian thực tới Máy Chủ Master DB (Kieu) qua WebRTC RTCDataChannel"
          >
            {clusterStatus === 'CONNECTED' ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <Wifi className="w-3.5 h-3.5 text-emerald-600" />
                <span>Đã kết nối Host Kieu</span>
              </>
            ) : clusterStatus === 'SIGNALING' ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-600" />
                <span>Đang bắt tay Host Kieu...</span>
              </>
            ) : clusterStatus === 'HOST_OFFLINE' ? (
              <>
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                <Radio className="w-3.5 h-3.5 text-amber-700" />
                <span>Host Kieu Chưa Bật (Lưu Cục Bộ)</span>
              </>
            ) : (
              <>
                <Radio className="w-3.5 h-3.5 text-white" />
                <span>⚡ Kết Nối Host Kieu</span>
              </>
            )}
          </button>
        )}

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

        {/* Export Button (yêu cầu quyền quản lý chấm công) */}
        {hasPermission('MANAGE_TIMESHEET') && (
          <button
            onClick={handleExportExcel}
            className="flex items-center gap-2 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-xl transition shadow-sm shadow-emerald-200"
            title="Xuất bảng chốt công chuẩn theo mẫu KIỂM TRA CHÔT CÔNG THÁNG 08.2026.xlsx"
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span className="hidden lg:inline">{t('exportExcel')}</span>
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

      {/* Modal Quản Lý Thư Mục HR_Signaling_Data & Ghép Nối Mã Offline */}
      {isFolderModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-3xl shadow-2xl max-w-lg w-full border border-slate-100 overflow-hidden space-y-0">
            {/* Modal Header */}
            <div className="p-4 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-amber-500/20 rounded-xl border border-amber-500/30 text-amber-400">
                  {modalTab === 'folder' ? <Folder className="w-5 h-5" /> : <Link2 className="w-5 h-5 text-indigo-300" />}
                </div>
                <div>
                  <h3 className="text-sm font-bold">
                    {modalTab === 'folder' ? 'Thư Mục Tín Hiệu P2P (OneDrive)' : 'Ghép Nối WebRTC P2P Bằng Mã (Offline)'}
                  </h3>
                  <p className="text-[11px] text-slate-300">
                    {modalTab === 'folder' ? 'HR_Signaling_Data (Tự động trao đổi file)' : 'Dành cho tệp offline file:/// hoặc mạng không thư mục'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setIsFolderModalOpen(false);
                  setGeneratedPairToken('');
                  setInputPairToken('');
                  setHasCopiedPairToken(false);
                }}
                className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-white/10 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Tab Navigation */}
            <div className="flex border-b border-slate-100 bg-slate-50 px-3 pt-2 gap-1 text-xs">
              <button
                type="button"
                onClick={() => setModalTab('folder')}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-t-xl font-bold transition border-b-2 ${
                  modalTab === 'folder'
                    ? 'bg-white text-indigo-700 border-indigo-600 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 border-transparent'
                }`}
              >
                <Folder className="w-3.5 h-3.5" />
                <span>Thư Mục Tín Hiệu (OneDrive)</span>
              </button>
              <button
                type="button"
                onClick={() => setModalTab('token')}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-t-xl font-bold transition border-b-2 ${
                  modalTab === 'token'
                    ? 'bg-white text-indigo-700 border-indigo-600 shadow-xs'
                    : 'text-slate-500 hover:text-slate-800 border-transparent'
                }`}
              >
                <Link2 className="w-3.5 h-3.5" />
                <span>Ghép Nối Mã Offline</span>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-4 text-xs">
              {modalTab === 'folder' ? (
                folderSignaling.isSupported() ? (
                  <>
                    <div className="p-3.5 bg-slate-50 rounded-2xl border border-slate-200 space-y-2.5">
                      <div className="flex justify-between items-center">
                        <span className="text-slate-500 font-semibold">Tên thư mục đã chọn:</span>
                        <span className="font-bold text-slate-800 font-mono bg-white px-2 py-0.5 rounded border border-slate-200">
                          {folderName || 'HR_Signaling_Data'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-slate-500 font-semibold">Quyền đọc/ghi (Edge):</span>
                        <span className="font-bold text-emerald-600 flex items-center gap-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Đã cấp quyền hoạt động
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-slate-500 font-semibold">Trạng thái Host Kiều:</span>
                        {folderHostCheck?.online ? (
                          <span className="font-bold text-emerald-600 flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                            Đang Online (Sẵn Sàng)
                          </span>
                        ) : (
                          <span className="font-bold text-amber-600 flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-amber-500" />
                            Chưa online hoặc đang chờ tín hiệu
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="p-3 bg-indigo-50/60 rounded-2xl border border-indigo-100 text-slate-600 space-y-1">
                      <p className="font-bold text-indigo-900">💡 Tự Động Trao Đổi File Tín Hiệu:</p>
                      <p>• Khi Host Kiều bật, file trạng thái <code>host_status.json</code> được duy trì liên tục.</p>
                      <p>• Máy Client ghi tín hiệu bắt tay vào <code>HR_Signaling_Data</code> để tự động kết nối P2P WebRTC.</p>
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                      <button
                        type="button"
                        onClick={async () => {
                          const picked = await folderSignaling.pickDirectory();
                          if (picked) {
                            success('Đã đổi thư mục', `Đã liên kết với thư mục "${folderSignaling.getFolderName()}"`);
                            setIsFolderModalOpen(false);
                          }
                        }}
                        className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition"
                      >
                        Chọn Thư Mục Khác
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          setIsFolderModalOpen(false);
                          await handleOneTouchConnect();
                        }}
                        className="px-4 py-2 bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-bold rounded-xl transition shadow-sm"
                      >
                        ⚡ Bắt Tay Kết Nối Lại
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="space-y-3">
                    <div className="p-3.5 bg-amber-50 rounded-2xl border border-amber-200 space-y-2 text-amber-900">
                      <p className="font-bold flex items-center gap-1.5">
                        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                        Trình duyệt hiện tại chưa hỗ trợ chọn thư mục
                      </p>
                      <p className="leading-relaxed text-[11px] text-amber-800">
                        Tính năng quét thư mục tự động yêu cầu trình duyệt Microsoft Edge hoặc Google Chrome.
                      </p>
                    </div>
                    <div className="flex justify-end pt-2">
                      <button
                        type="button"
                        onClick={() => setModalTab('token')}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl transition shadow-sm flex items-center gap-1.5"
                      >
                        <Link2 className="w-3.5 h-3.5" />
                        <span>Chuyển Sang Ghép Nối Bằng Mã</span>
                      </button>
                    </div>
                  </div>
                )
              ) : (
                /* Tab 2: Token Offline Pairing */
                <div className="space-y-4">
                  <p className="text-[11px] text-slate-500 leading-relaxed">
                    Dành cho môi trường mở trực tiếp file <code>dist/index.html</code> (không qua web server). Hai máy chỉ cần sao chép mã token qua Zalo/Teams để bắt tay RTCDataChannel tức thời.
                  </p>

                  {isClusterHost ? (
                    <div className="space-y-4">
                      <div className="p-3 bg-amber-50 border border-amber-200 rounded-2xl space-y-2">
                        <div className="text-xs font-bold text-amber-900 flex items-center justify-between">
                          <span>1. Chọn máy Client muốn kết nối:</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <select
                            value={pairClientId}
                            onChange={(e) => setPairClientId(e.target.value)}
                            className="px-3 py-1.5 bg-white border border-amber-300 rounded-xl text-xs font-bold text-slate-800 grow"
                          >
                            {clusterService.getConfig().nodes.filter(n => n.role !== 'HOST').map(n => (
                              <option key={n.id} value={n.id}>{n.name} ({n.id})</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={async () => {
                              setIsPairWorking(true);
                              try {
                                const tok = await clusterService.createPairingOfferToken(pairClientId);
                                setGeneratedPairToken(tok);
                                success('Đã tạo mã kết nối Host', 'Vui lòng sao chép gửi cho Client.');
                              } catch (err: any) {
                                error('Lỗi tạo mã', err.message);
                              } finally {
                                setIsPairWorking(false);
                              }
                            }}
                            disabled={isPairWorking}
                            className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white font-bold text-xs rounded-xl transition shrink-0 disabled:opacity-50"
                          >
                            {isPairWorking ? 'Đang tạo...' : 'Tạo Mã Gửi Client'}
                          </button>
                        </div>
                      </div>

                      {generatedPairToken && (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                            <span>Mã Token gửi máy Client:</span>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(generatedPairToken);
                                setHasCopiedPairToken(true);
                                setTimeout(() => setHasCopiedPairToken(false), 2000);
                                success('Đã sao chép mã token vào bộ nhớ tạm');
                              }}
                              className="flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-700 font-bold"
                            >
                              {hasCopiedPairToken ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                              <span>{hasCopiedPairToken ? 'Đã sao chép' : 'Sao chép mã'}</span>
                            </button>
                          </div>
                          <textarea
                            readOnly
                            value={generatedPairToken}
                            rows={3}
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-mono text-slate-700 break-all select-all"
                          />
                        </div>
                      )}

                      <div className="space-y-1.5 pt-2 border-t border-slate-100">
                        <label className="block text-xs font-bold text-slate-700">
                          2. Dán Mã Phản Hồi (Answer Token) từ Client gửi về:
                        </label>
                        <textarea
                          value={inputPairToken}
                          onChange={(e) => setInputPairToken(e.target.value)}
                          placeholder="Dán mã phản hồi do máy trạm Client tạo ra vào đây..."
                          rows={3}
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-mono text-slate-800"
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            if (!inputPairToken.trim()) return;
                            setIsPairWorking(true);
                            try {
                              await clusterService.acceptAnswerToken(pairClientId, inputPairToken);
                              success('Kết nối thành công!', `Máy chủ Host đã bắt tay thành công với ${pairClientId}.`);
                              setIsFolderModalOpen(false);
                            } catch (err: any) {
                              error('Lỗi nạp mã phản hồi', err.message);
                            } finally {
                              setIsPairWorking(false);
                            }
                          }}
                          disabled={isPairWorking || !inputPairToken.trim()}
                          className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl transition shadow-sm disabled:opacity-50"
                        >
                          {isPairWorking ? 'Đang bắt tay...' : 'Chốt Bắt Tay Kết Nối'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="space-y-1.5">
                        <label className="block text-xs font-bold text-slate-700">
                          1. Dán Mã Token nhận được từ Host Kiều:
                        </label>
                        <textarea
                          value={inputPairToken}
                          onChange={(e) => setInputPairToken(e.target.value)}
                          placeholder="Dán mã token từ máy Host Kiều vào đây..."
                          rows={3}
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-mono text-slate-800"
                        />
                        <button
                          type="button"
                          onClick={async () => {
                            if (!inputPairToken.trim()) return;
                            setIsPairWorking(true);
                            try {
                              const ans = await clusterService.acceptOfferTokenAndCreateAnswer(inputPairToken);
                              setGeneratedPairToken(ans);
                              success('Đã tạo mã phản hồi!', 'Hãy sao chép mã này gửi lại cho Host Kiều để hoàn tất kết nối.');
                            } catch (err: any) {
                              error('Lỗi xử lý mã Host', err.message);
                            } finally {
                              setIsPairWorking(false);
                            }
                          }}
                          disabled={isPairWorking || !inputPairToken.trim()}
                          className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl transition shadow-sm disabled:opacity-50"
                        >
                          {isPairWorking ? 'Đang tạo mã phản hồi...' : 'Tạo Mã Phản Hồi Gửi Lại Cho Host'}
                        </button>
                      </div>

                      {generatedPairToken && (
                        <div className="space-y-1.5 pt-2 border-t border-slate-100">
                          <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                            <span>2. Mã phản hồi gửi lại cho Host Kiều:</span>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(generatedPairToken);
                                setHasCopiedPairToken(true);
                                setTimeout(() => setHasCopiedPairToken(false), 2000);
                                success('Đã sao chép mã phản hồi vào bộ nhớ tạm');
                              }}
                              className="flex items-center gap-1 text-[11px] text-emerald-600 hover:text-emerald-700 font-bold"
                            >
                              {hasCopiedPairToken ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                              <span>{hasCopiedPairToken ? 'Đã sao chép' : 'Sao chép mã'}</span>
                            </button>
                          </div>
                          <textarea
                            readOnly
                            value={generatedPairToken}
                            rows={3}
                            className="w-full px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-xl text-[11px] font-mono text-emerald-900 break-all select-all"
                          />
                          <p className="text-[11px] text-emerald-700">
                            Sau khi Host Kiều dán mã này vào máy chủ, kênh RTCDataChannel sẽ lập tức mở và chuyển sang màu xanh 🟢!
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
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
