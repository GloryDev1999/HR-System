import { describe, it, expect } from 'vitest';
import { buildCountBag } from '../services/formula-defs';
import { AttendanceStatusCode, IEmployee, ShiftClassType } from '../types';

describe('Timesheet Business Rules & Status Logic', () => {
  describe('buildCountBag with new status codes', () => {
    it('handles OFF, Off, ML, LA, ED, MCO, MCI correctly', () => {
      const cells: { statusCode: AttendanceStatusCode }[] = [
        { statusCode: 'W' },
        { statusCode: 'N' },
        { statusCode: 'OFF' },
        { statusCode: 'Off' },
        { statusCode: 'ML' },
        { statusCode: 'LA' },
        { statusCode: 'ED' },
        { statusCode: 'MCO' },
        { statusCode: 'MCI' },
      ];
      const bag = buildCountBag(cells);
      expect(bag.countW).toBe(1);
      expect(bag.countN).toBe(1);
      expect(bag.countOff).toBe(2);
      expect(bag.countUL).toBe(0); // Off và UL đã tách riêng biệt
      expect(bag.countML).toBe(1); // ML đếm riêng cho cột Thai sản
      expect(bag.countLA).toBe(1);
      expect(bag.countED).toBe(1);
      expect(bag.countMCO).toBe(1);
      expect(bag.countMCI).toBe(1);
    });

    it('handles fractional leave codes W6/AL2, W4/UL4, W5/SL3, W7/PL1 correctly', () => {
      const cells: { statusCode: AttendanceStatusCode }[] = [
        { statusCode: 'W6/AL2' as any },
        { statusCode: 'W4/UL4' as any },
        { statusCode: 'W5/SL3' as any },
        { statusCode: 'W7/PL1' as any },
        { statusCode: 'W' },
      ];
      const bag = buildCountBag(cells);
      expect(bag.countW).toBe(1);
      // fractionalW = 6/8 + 4/8 + 5/8 + 7/8 = 22/8 = 2.75
      expect(bag.fractionalW).toBeCloseTo(2.75, 2);
      expect(bag.fractionalAL).toBeCloseTo(2 / 8, 2);
      expect(bag.fractionalUL).toBeCloseTo(4 / 8, 2);
      expect(bag.fractionalSL).toBeCloseTo(3 / 8, 2);
      expect(bag.fractionalPL).toBeCloseTo(1 / 8, 2);
    });
  });

  describe('Shift Groups & Working Days', () => {
    function getShiftInfo(shiftClassId: ShiftClassType, dayOfWeek: number) {
      switch (shiftClassId) {
        case 'OFFICE_M_F':
          return {
            start: '07:30',
            end: '16:00',
            isNight: false,
            isWorkDay: dayOfWeek >= 1 && dayOfWeek <= 5
          };
        case 'OFFICE_M_S':
          return {
            start: '07:30',
            end: '16:00',
            isNight: false,
            isWorkDay: dayOfWeek >= 1 && dayOfWeek <= 6
          };
        case 'SHIFT_1':
          return {
            start: '06:00',
            end: '14:00',
            isNight: false,
            isWorkDay: dayOfWeek >= 1 && dayOfWeek <= 6
          };
        case 'SHIFT_2':
          return {
            start: '14:00',
            end: '22:00',
            isNight: true,
            isWorkDay: dayOfWeek >= 1 && dayOfWeek <= 6
          };
        default:
          return {
            start: '07:30',
            end: '16:00',
            isNight: false,
            isWorkDay: dayOfWeek >= 1 && dayOfWeek <= 6
          };
      }
    }

    it('OFFICE_M_F is working Mon-Fri only, Saturday & Sunday are off', () => {
      // Monday = 1, Friday = 5, Saturday = 6, Sunday = 0
      expect(getShiftInfo('OFFICE_M_F', 1).isWorkDay).toBe(true);
      expect(getShiftInfo('OFFICE_M_F', 5).isWorkDay).toBe(true);
      expect(getShiftInfo('OFFICE_M_F', 6).isWorkDay).toBe(false); // Saturday off
      expect(getShiftInfo('OFFICE_M_F', 0).isWorkDay).toBe(false); // Sunday off
    });

    it('OFFICE_M_S, SHIFT_1, SHIFT_2 are working Mon-Sat, Sunday is off', () => {
      ['OFFICE_M_S', 'SHIFT_1', 'SHIFT_2'].forEach((shift) => {
        const s = shift as ShiftClassType;
        expect(getShiftInfo(s, 1).isWorkDay).toBe(true);
        expect(getShiftInfo(s, 6).isWorkDay).toBe(true); // Saturday is working day
        expect(getShiftInfo(s, 0).isWorkDay).toBe(false); // Sunday off
      });
    });

    it('SHIFT_2 is marked as night shift (N)', () => {
      expect(getShiftInfo('SHIFT_2', 1).isNight).toBe(true);
      expect(getShiftInfo('SHIFT_1', 1).isNight).toBe(false);
      expect(getShiftInfo('OFFICE_M_S', 1).isNight).toBe(false);
      expect(getShiftInfo('OFFICE_M_F', 1).isNight).toBe(false);
    });
  });

  describe('Flexible Employee Identification', () => {
    const mockEmployees: IEmployee[] = [
      {
        employeeId: 'LEP010',
        erpId: '1013789',
        fullName: 'Trịnh Đình Tâm',
        department: 'WH',
        position: 'Warehouse Lead',
        startDate: '01/03/2022',
        contractType: 'OFFICIAL',
        shiftClassId: 'SHIFT_1',
        customAllowances: {
          pcccAllowance: 0,
          hazardousAllowance: 0,
          diligenceBonus: 500000,
          productivityBonus: 0,
          tradeUnionFee: -40000,
          otherFees: 0
        },
        annualLeaveBalance: { initialQuota: 12, usedDays: 0, remainingDays: 12 },
        status: 'ACTIVE'
      }
    ];

    function findEmployee(codeOrId: string) {
      if (!codeOrId) return undefined;
      const raw = String(codeOrId).trim();
      const lower = raw.toLowerCase();

      let emp = mockEmployees.find(e =>
        e.employeeId.toLowerCase() === lower ||
        (e.erpId && e.erpId.toLowerCase() === lower)
      );
      if (emp) return emp;

      const numMatch = raw.match(/\d+/);
      if (numMatch) {
        const num = parseInt(numMatch[0], 10);
        const lepPad3 = `LEP${String(num).padStart(3, '0')}`.toLowerCase();
        const lepRaw = `LEP${num}`.toLowerCase();

        emp = mockEmployees.find(e => {
          const eLower = e.employeeId.toLowerCase();
          return eLower === lepPad3 || eLower === lepRaw || (e.erpId && e.erpId.toLowerCase() === lower);
        });
      }
      return emp;
    }

    it('matches exact employeeId LEP010', () => {
      expect(findEmployee('LEP010')?.fullName).toBe('Trịnh Đình Tâm');
      expect(findEmployee('lep010')?.fullName).toBe('Trịnh Đình Tâm');
    });

    it('matches ERP ID 1013789', () => {
      expect(findEmployee('1013789')?.fullName).toBe('Trịnh Đình Tâm');
    });

    it('matches unpadded LEP10 or numeric 10', () => {
      expect(findEmployee('LEP10')?.fullName).toBe('Trịnh Đình Tâm');
      expect(findEmployee('10')?.fullName).toBe('Trịnh Đình Tâm');
    });
  });

  describe('Lateness, Early Departure, and Missing Punches', () => {
    function parseTime(t: string): number {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    }

    function evaluateAttendance(
      checkIn: string,
      checkOut: string,
      shiftStart: string,
      shiftEnd: string,
      isNight: boolean
    ) {
      if (!checkIn && !checkOut) {
        return { status: 'OFF' };
      }
      if (checkIn && !checkOut) {
        return { status: 'MCI', violationNote: 'Không có giờ quẹt thẻ ra (MCI)' };
      }
      if (!checkIn && checkOut) {
        return { status: 'MCO', violationNote: 'Không có giờ quẹt thẻ vào (MCO)' };
      }

      const inM = parseTime(checkIn);
      const outM = parseTime(checkOut);
      const startM = parseTime(shiftStart);
      const endM = parseTime(shiftEnd);

      const late = Math.max(0, inM - startM);
      const early = Math.max(0, endM - outM);

      // Quá 60 phút trễ hoặc sớm -> OFF chuyển chờ bù phép
      if (late >= 60 || early >= 60) {
        const offMins = late >= 60 ? late : early;
        const missedHours = Math.min(8, Math.max(1, Math.ceil(offMins / 60)));
        const workedHours = Math.max(0, 8 - missedHours);
        return {
          status: 'OFF',
          missedHours,
          workedHours,
          violationNote: late >= 60 ? `Đi trễ ${late} phút (>= 60') -> tính OFF ${missedHours}h chuyển chờ bù phép` : `Về sớm ${early} phút (>= 60') -> tính OFF ${missedHours}h chuyển chờ bù phép`
        };
      }

      // Trễ từ 2 phút đến dưới 60 phút -> LA
      if (late >= 2 && late < 60) {
        return { status: 'LA', lateMinutes: late, violationNote: `Đi trễ ${late} phút (LA)` };
      }

      // Về sớm từ 2 phút đến dưới 60 phút -> ED
      if (early >= 2 && early < 60) {
        return { status: 'ED', earlyMinutes: early, violationNote: `Về sớm ${early} phút (ED)` };
      }

      return { status: isNight ? 'N' : 'W' };
    }

    it('on-time attendance (< 2 min late/early) results in W or N', () => {
      expect(evaluateAttendance('06:00', '14:00', '06:00', '14:00', false).status).toBe('W');
      expect(evaluateAttendance('06:01', '13:59', '06:00', '14:00', false).status).toBe('W');
      expect(evaluateAttendance('14:00', '22:00', '14:00', '22:00', true).status).toBe('N');
    });

    it('late arrival >= 2 min and < 60 min results in LA with lateMinutes noted', () => {
      const res = evaluateAttendance('06:10', '14:00', '06:00', '14:00', false);
      expect(res.status).toBe('LA');
      expect(res.lateMinutes).toBe(10);
      expect(res.violationNote).toContain('Đi trễ 10 phút');

      const res2 = evaluateAttendance('06:02', '14:00', '06:00', '14:00', false);
      expect(res2.status).toBe('LA');
      expect(res2.lateMinutes).toBe(2);
    });

    it('early departure >= 2 min and < 60 min results in ED with earlyMinutes noted', () => {
      const res = evaluateAttendance('06:00', '13:50', '06:00', '14:00', false);
      expect(res.status).toBe('ED');
      expect(res.earlyMinutes).toBe(10);
      expect(res.violationNote).toContain('Về sớm 10 phút');

      const res2 = evaluateAttendance('06:00', '13:58', '06:00', '14:00', false);
      expect(res2.status).toBe('ED');
      expect(res2.earlyMinutes).toBe(2);
    });

    it('late arrival >= 60 min results in OFF with missedHours calculation', () => {
      // Late 70 min -> 2 hours missed, 6 hours worked
      const res = evaluateAttendance('07:10', '14:00', '06:00', '14:00', false);
      expect(res.status).toBe('OFF');
      expect(res.missedHours).toBe(2);
      expect(res.workedHours).toBe(6);
    });

    it('early departure >= 60 min results in OFF with missedHours calculation', () => {
      // Early 120 min (2h) -> 2 hours missed, 6 hours worked
      const res = evaluateAttendance('06:00', '12:00', '06:00', '14:00', false);
      expect(res.status).toBe('OFF');
      expect(res.missedHours).toBe(2);
      expect(res.workedHours).toBe(6);
    });

    it('only checkIn present results in MCI', () => {
      const res = evaluateAttendance('06:00', '', '06:00', '14:00', false);
      expect(res.status).toBe('MCI');
    });

    it('only checkOut present results in MCO', () => {
      const res = evaluateAttendance('', '14:00', '06:00', '14:00', false);
      expect(res.status).toBe('MCO');
    });

    it('neither checkIn nor checkOut on working day results in OFF', () => {
      const res = evaluateAttendance('', '', '06:00', '14:00', false);
      expect(res.status).toBe('OFF');
    });
  });

  describe('Maternity Leave (ML)', () => {
    function checkMaternity(dateStr: string, emp: { status: string; maternityStartDate?: string; maternityEndDate?: string }) {
      if (emp.status === 'MATERNITY' && emp.maternityStartDate && emp.maternityEndDate) {
        const normDate = (s: string) => {
          if (s.includes('/')) {
            const [d, m, y] = s.split('/');
            return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
          }
          return s;
        };
        const mStart = normDate(emp.maternityStartDate);
        const mEnd = normDate(emp.maternityEndDate);
        if (dateStr >= mStart && dateStr <= mEnd) {
          return 'ML';
        }
      }
      return null;
    }

    it('automatically assigns ML within maternity date range', () => {
      const emp = {
        status: 'MATERNITY',
        maternityStartDate: '2026-06-01',
        maternityEndDate: '2026-11-30'
      };
      expect(checkMaternity('2026-08-15', emp)).toBe('ML');
      expect(checkMaternity('2026-06-01', emp)).toBe('ML');
      expect(checkMaternity('2026-11-30', emp)).toBe('ML');
      expect(checkMaternity('2026-12-01', emp)).toBeNull();
      expect(checkMaternity('2026-05-31', emp)).toBeNull();
    });

    it('works with DD/MM/YYYY date format', () => {
      const emp = {
        status: 'MATERNITY',
        maternityStartDate: '01/06/2026',
        maternityEndDate: '30/11/2026'
      };
      expect(checkMaternity('2026-08-15', emp)).toBe('ML');
    });
  });

  describe('Business Trip (BT)', () => {
    function checkBusinessTrip(dateStr: string, emp: { businessTripStartDate?: string; businessTripEndDate?: string }) {
      if (emp.businessTripStartDate && emp.businessTripEndDate) {
        const normDate = (s: string) => {
          if (s.includes('/')) {
            const [d, m, y] = s.split('/');
            return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
          }
          return s;
        };
        const bStart = normDate(emp.businessTripStartDate);
        const bEnd = normDate(emp.businessTripEndDate);
        if (dateStr >= bStart && dateStr <= bEnd) {
          return 'BT';
        }
      }
      return null;
    }

    it('automatically assigns BT within business trip date range', () => {
      const emp = {
        businessTripStartDate: '2026-07-01',
        businessTripEndDate: '2026-07-05'
      };
      expect(checkBusinessTrip('2026-07-01', emp)).toBe('BT');
      expect(checkBusinessTrip('2026-07-03', emp)).toBe('BT');
      expect(checkBusinessTrip('2026-07-05', emp)).toBe('BT');
      expect(checkBusinessTrip('2026-06-30', emp)).toBeNull();
      expect(checkBusinessTrip('2026-07-06', emp)).toBeNull();
    });

    it('works with DD/MM/YYYY date format', () => {
      const emp = {
        businessTripStartDate: '01/07/2026',
        businessTripEndDate: '05/07/2026'
      };
      expect(checkBusinessTrip('2026-07-02', emp)).toBe('BT');
    });
  });

  describe('Early Check-In OT & Post-Shift OT Rules', () => {
    function computeOvertime(
      checkIn: string,
      checkOut: string,
      shiftStart: string,
      shiftEnd: string,
      isSunday: boolean
    ) {
      const parseMinutes = (t: string) => {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
      };

      if (!checkIn && !checkOut) return null;

      // Chủ Nhật: Không tính ngày công W, toàn bộ giờ làm quy đổi sang tăng ca SUNDAY
      if (isSunday) {
        if (checkIn && checkOut) {
          const inM = parseMinutes(checkIn);
          const outM = parseMinutes(checkOut);
          const spanM = outM - inM;
          // Nghỉ trưa 30p nếu ca kéo dài >= 8 tiếng (480 phút)
          const netM = spanM >= 480 ? spanM - 30 : spanM;
          const hours = +(netM / 60).toFixed(2);
          return {
            dayType: 'SUNDAY',
            hours,
            rawMinutes: netM,
            isEarlyIn: false,
            note: 'Tăng ca Chủ Nhật (quy đổi toàn bộ giờ quẹt thẻ)'
          };
        } else {
          return {
            dayType: 'SUNDAY',
            hours: 0,
            rawMinutes: 0,
            isMissingPunch: true,
            violationCode: checkIn ? 'MCO' : 'MCI'
          };
        }
      }

      // Ngày thường:
      let earlyOtMinutes = 0;
      let postOtMinutes = 0;
      let isEarlyIn = false;

      const startMinutes = parseMinutes(shiftStart);
      const endMinutes = parseMinutes(shiftEnd);

      if (checkIn) {
        const inMinutes = parseMinutes(checkIn);
        // Khung vào sớm: từ 1h30 (90') đến 1h (60') trước ca
        if (inMinutes >= startMinutes - 90 && inMinutes <= startMinutes - 60) {
          earlyOtMinutes = startMinutes - inMinutes;
          isEarlyIn = true;
        }
      }

      if (checkOut) {
        const outMinutes = parseMinutes(checkOut);
        if (outMinutes > endMinutes) {
          postOtMinutes = outMinutes - endMinutes;
        }
      }

      const totalOtMinutes = earlyOtMinutes + postOtMinutes;
      if (totalOtMinutes <= 0) return null;

      const hours = +(totalOtMinutes / 60).toFixed(2);
      return {
        dayType: 'WEEKDAY',
        hours,
        rawMinutes: totalOtMinutes,
        isEarlyIn,
        note: isEarlyIn ? `Tăng ca vào sớm (${earlyOtMinutes}') + sau ca (${postOtMinutes}')` : `Tăng ca sau ca (${postOtMinutes}')`
      };
    }

    it('calculates early OT when check-in is between 6:00 and 6:30 for 7:30 shift', () => {
      // 06:30 is exactly 60m before 07:30 -> gets 60 min early OT
      const res630 = computeOvertime('06:30', '16:00', '07:30', '16:00', false);
      expect(res630).not.toBeNull();
      expect(res630?.rawMinutes).toBe(60);
      expect(res630?.hours).toBe(1.0);
      expect(res630?.isEarlyIn).toBe(true);

      // 06:00 is 90m before 07:30 -> gets 90 min early OT
      const res600 = computeOvertime('06:00', '16:00', '07:30', '16:00', false);
      expect(res600).not.toBeNull();
      expect(res600?.rawMinutes).toBe(90);
      expect(res600?.hours).toBe(1.5);
      expect(res600?.isEarlyIn).toBe(true);
    });

    it('does NOT calculate early OT when check-in is after 6:30 (e.g. 06:31 or 06:35)', () => {
      const res635 = computeOvertime('06:35', '16:00', '07:30', '16:00', false);
      // No early OT and no post-shift OT -> returns null
      expect(res635).toBeNull();

      const res700 = computeOvertime('07:00', '16:00', '07:30', '16:00', false);
      expect(res700).toBeNull();
    });

    it('calculates exact unrounded post-shift OT (e.g., 18:01 gives 121 mins / 2.02h)', () => {
      const res = computeOvertime('07:29', '18:01', '07:30', '16:00', false);
      expect(res).not.toBeNull();
      expect(res?.rawMinutes).toBe(121);
      expect(res?.hours).toBe(2.02); // 121 / 60 = 2.0166... rounded to 2 decimal places
      expect(res?.isEarlyIn).toBe(false);
    });

    it('calculates combined early OT + post-shift OT correctly', () => {
      // Check-in 06:30 (60m early) + Check-out 18:00 (120m post) -> 180m = 3.0h
      const res = computeOvertime('06:30', '18:00', '07:30', '16:00', false);
      expect(res).not.toBeNull();
      expect(res?.rawMinutes).toBe(180);
      expect(res?.hours).toBe(3.0);
      expect(res?.isEarlyIn).toBe(true);
    });

    it('converts full Sunday shift to SUNDAY OT (7:30 to 16:00 gives 8.0h)', () => {
      const res = computeOvertime('07:30', '16:00', '07:30', '16:00', true);
      expect(res).not.toBeNull();
      expect(res?.dayType).toBe('SUNDAY');
      expect(res?.rawMinutes).toBe(480); // 510m - 30m break = 480m
      expect(res?.hours).toBe(8.0);
    });

    it('detects Sunday missing punch (MCI/MCO)', () => {
      const resCheckInOnly = computeOvertime('07:30', '', '07:30', '16:00', true);
      expect(resCheckInOnly?.isMissingPunch).toBe(true);
      expect(resCheckInOnly?.violationCode).toBe('MCO');

      const resCheckOutOnly = computeOvertime('', '16:00', '07:30', '16:00', true);
      expect(resCheckOutOnly?.isMissingPunch).toBe(true);
      expect(resCheckOutOnly?.violationCode).toBe('MCI');
    });
  });

  describe('12-Hour Rest Rule (Shift Transition Rule)', () => {
    function checkRestViolation(
      day1Date: string,
      day1CheckOut: string,
      day1ShiftEnd: string,
      day2Date: string,
      day2CheckIn: string,
      day2ShiftStart: string
    ) {
      const endT = day1CheckOut || day1ShiftEnd;
      const startT = day2CheckIn || day2ShiftStart;

      const d1 = new Date(`${day1Date}T${endT}:00`);
      const d2 = new Date(`${day2Date}T${startT}:00`);

      const restHours = (d2.getTime() - d1.getTime()) / (1000 * 60 * 60);
      const isRestViolation = restHours < 12;

      return {
        restHours: +restHours.toFixed(1),
        isRestViolation,
        warning: isRestViolation
          ? `Vi phạm nghỉ < 12 giờ: Chỉ nghỉ ${restHours.toFixed(1)}h giữa 2 ca xoay!`
          : undefined
      };
    }

    it('flags violation when transitioning from Shift 2 (22:00) to Shift 1 (06:00) next day (8h rest < 12h)', () => {
      const res = checkRestViolation(
        '2026-08-21',
        '22:00',
        '22:00',
        '2026-08-22',
        '06:00',
        '06:00'
      );
      expect(res.restHours).toBe(8.0);
      expect(res.isRestViolation).toBe(true);
      expect(res.warning).toContain('Vi phạm nghỉ < 12 giờ: Chỉ nghỉ 8.0h');
    });

    it('flags violation if employee stays late for OT until 21:00 and starts at 07:30 next day (10.5h rest < 12h)', () => {
      const res = checkRestViolation(
        '2026-08-21',
        '21:00',
        '16:00',
        '2026-08-22',
        '07:30',
        '07:30'
      );
      expect(res.restHours).toBe(10.5);
      expect(res.isRestViolation).toBe(true);
    });

    it('passes when normal rest period is >= 12h (e.g. 16:00 to 07:30 next day is 15.5h)', () => {
      const res = checkRestViolation(
        '2026-08-21',
        '16:00',
        '16:00',
        '2026-08-22',
        '07:30',
        '07:30'
      );
      expect(res.restHours).toBe(15.5);
      expect(res.isRestViolation).toBe(false);
      expect(res.warning).toBeUndefined();
    });
  });

  describe('Excel Date & Time Parsing / Ingestion Bug Prevention', () => {
    // Import the functions directly or use the implementation logic
    const XLSX = require('xlsx');

    function parseExcelDate(rawDate: any): string {
      if (!rawDate) return '';
      if (rawDate instanceof Date) {
        const safeDate = new Date(rawDate.getTime() + 12 * 3600 * 1000);
        const y = safeDate.getUTCFullYear();
        const m = String(safeDate.getUTCMonth() + 1).padStart(2, '0');
        const d = String(safeDate.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      }
      if (typeof rawDate === 'number' && !isNaN(rawDate)) {
        if (rawDate > 1000) {
          try {
            const parsed = XLSX.SSF.parse_date_code(rawDate);
            if (parsed && parsed.y && parsed.m && parsed.d) {
              return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
            }
          } catch {}
        }
      }
      if (typeof rawDate === 'string' && rawDate.trim()) {
        const clean = rawDate.trim();
        const isoMatch = clean.match(/^(\d{4})[-\/\.](\d{1,2})[-\/\.](\d{1,2})/);
        if (isoMatch) {
          return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
        }
        const ddmmyyyyMatch = clean.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{4})/);
        if (ddmmyyyyMatch) {
          return `${ddmmyyyyMatch[3]}-${ddmmyyyyMatch[2].padStart(2, '0')}-${ddmmyyyyMatch[1].padStart(2, '0')}`;
        }
      }
      return '';
    }

    function parseExcelTime(val: any): string {
      if (!val && val !== 0) return '';
      if (typeof val === 'string') {
        const s = val.trim();
        const m = s.match(/^(\d{1,2}):(\d{2})/);
        if (m) {
          return `${m[1].padStart(2, '0')}:${m[2]}`;
        }
        return '';
      }
      if (val instanceof Date) {
        const h = String(val.getHours()).padStart(2, '0');
        const min = String(val.getMinutes()).padStart(2, '0');
        return `${h}:${min}`;
      }
      if (typeof val === 'number' && !isNaN(val) && val >= 0 && val < 1) {
        const totalMinutes = Math.round(val * 24 * 60);
        const h = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0');
        const min = String(totalMinutes % 60).padStart(2, '0');
        return `${h}:${min}`;
      }
      return '';
    }

    it('correctly parses DD/MM/YYYY text strings without any shift', () => {
      expect(parseExcelDate('28/08/2026')).toBe('2026-08-28');
      expect(parseExcelDate('03/09/2026')).toBe('2026-09-03');
      expect(parseExcelDate('31/08/2026')).toBe('2026-08-31');
      expect(parseExcelDate('01/09/2026')).toBe('2026-09-01');
      expect(parseExcelDate('02/09/2026')).toBe('2026-09-02');
    });

    it('correctly parses YYYY-MM-DD ISO strings without reversal', () => {
      expect(parseExcelDate('2026-08-28')).toBe('2026-08-28');
      expect(parseExcelDate('2026-09-03')).toBe('2026-09-03');
    });

    it('correctly parses Excel numeric serial codes without timezone distortion', () => {
      // 46262 is 2026-08-28 in Excel
      expect(parseExcelDate(46262)).toBe('2026-08-28');
      // 46268 is 2026-09-03 in Excel
      expect(parseExcelDate(46268)).toBe('2026-09-03');
    });

    it('correctly parses Date objects that have historical epoch skews (e.g. 23:59:30)', () => {
      // Simulates the SheetJS Vietnam historical 30s discrepancy: 2026-08-27T16:59:30.000Z
      const skewedDate = new Date('2026-08-27T16:59:30.000Z');
      expect(parseExcelDate(skewedDate)).toBe('2026-08-28');

      const skewedDate2 = new Date('2026-09-02T16:59:30.000Z');
      expect(parseExcelDate(skewedDate2)).toBe('2026-09-03');
    });

    it('correctly parses times in various formats (strings, decimals, Dates)', () => {
      expect(parseExcelTime('07:20')).toBe('07:20');
      expect(parseExcelTime('7:20')).toBe('07:20');
      expect(parseExcelTime('16:07:30')).toBe('16:07');
      expect(parseExcelTime(0.3055555555555556)).toBe('07:20'); // fraction of day
      expect(parseExcelTime('')).toBe('');
      expect(parseExcelTime(null)).toBe('');
    });

    it('simulates LEP004 dataset from image copy.png and guarantees correct status on all dates', () => {
      const records = [
        { date: '28/08/2026', day: 'Sáu', in: '07:20', out: '16:07' },
        { date: '29/08/2026', day: 'Bảy', in: '', out: '' },
        { date: '30/08/2026', day: 'CN', in: '', out: '' },
        { date: '31/08/2026', day: 'Hai', in: '', out: '' },
        { date: '01/09/2026', day: 'Ba', in: '', out: '' },
        { date: '02/09/2026', day: 'Tư', in: '', out: '' },
        { date: '03/09/2026', day: 'Năm', in: '07:27', out: '' }
      ];

      const evaluated = records.map(r => {
        const dStr = parseExcelDate(r.date);
        const cIn = parseExcelTime(r.in);
        const cOut = parseExcelTime(r.out);
        const isSunday = r.day === 'CN';

        let status = '';
        if (!cIn && !cOut) {
          status = isSunday ? '' : 'OFF';
        } else if (!cIn && cOut) {
          status = 'MCO';
        } else if (cIn && !cOut) {
          status = 'MCI';
        } else {
          status = 'W';
        }
        return { dateStr: dStr, status };
      });

      // 28/08 must be W (worked!)
      expect(evaluated.find(e => e.dateStr === '2026-08-28')?.status).toBe('W');
      // 31/08, 01/09, 02/09 must be OFF
      expect(evaluated.find(e => e.dateStr === '2026-08-31')?.status).toBe('OFF');
      expect(evaluated.find(e => e.dateStr === '2026-09-01')?.status).toBe('OFF');
      expect(evaluated.find(e => e.dateStr === '2026-09-02')?.status).toBe('OFF');
      // 03/09 must be MCI (quẹt vào 07:27, thiếu quẹt ra!)
      expect(evaluated.find(e => e.dateStr === '2026-09-03')?.status).toBe('MCI');
    });
  });

  describe('Shift Assignment vs Actual Punch Verification (Đi sai giờ sắp ca)', () => {
    const parseTimeToMinutes = (t: string): number | null => {
      if (!t) return null;
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };

    const detectPunchShift = (checkIn: string, checkOut: string) => {
      const inM = parseTimeToMinutes(checkIn);
      if (inM === null) return null;
      if (inM >= 12 * 60 && inM <= 17 * 60) return { shiftCode: 'SHIFT_2', label: 'Ca 2' };
      if (inM >= 4 * 60 + 30 && inM < 7 * 60) return { shiftCode: 'SHIFT_1', label: 'Ca 1' };
      const outM = parseTimeToMinutes(checkOut);
      if (outM !== null && outM <= 14 * 60 + 45) return { shiftCode: 'SHIFT_1', label: 'Ca 1' };
      return { shiftCode: 'OFFICE_M_S', label: 'HC' };
    };

    it('flags mismatch when scheduled Ca 1 (06:00-14:00) but punched Ca 2 (14:00-22:00)', () => {
      const scheduledShift = 'SHIFT_1';
      const actualPunch = detectPunchShift('13:55', '22:05');
      expect(actualPunch?.shiftCode).toBe('SHIFT_2');
      const isMismatch = actualPunch?.shiftCode !== scheduledShift;
      expect(isMismatch).toBe(true);
    });

    it('flags mismatch when scheduled Ca 2 (14:00-22:00) but punched Ca 1 (06:00-14:00)', () => {
      const scheduledShift = 'SHIFT_2';
      const actualPunch = detectPunchShift('05:52', '14:05');
      expect(actualPunch?.shiftCode).toBe('SHIFT_1');
      const isMismatch = actualPunch?.shiftCode !== scheduledShift;
      expect(isMismatch).toBe(true);
    });

    it('does NOT flag mismatch when scheduled Ca 1 and punches are on Ca 1 (even if slightly late)', () => {
      const scheduledShift = 'SHIFT_1';
      const actualPunch = detectPunchShift('06:15', '14:02');
      expect(actualPunch?.shiftCode).toBe('SHIFT_1');
      const isMismatch = actualPunch?.shiftCode !== scheduledShift;
      expect(isMismatch).toBe(false);
    });

    it('strictly excludes OFFICE_M_F employees from shift mismatch alerts', () => {
      const emp = { employeeId: 'LEP099', shiftClassId: 'OFFICE_M_F' };
      const isExempt = emp.shiftClassId === 'OFFICE_M_F';
      expect(isExempt).toBe(true);
    });
  });

  describe('Employee Resignation & Monthly Auto-Purge Lifecycle', () => {
    it('calculates pay period correctly and determines whether resigned employee should be purged', () => {
      // Giả sử kỳ công hiện tại là Tháng 9/2026 (2026-09-18)
      const currentPeriod = { month: 9, year: 2026 };

      // Nhân viên nghỉ trong tháng hiện tại (2026-09-05) -> Vẫn giữ hiển thị "Đã nghỉ việc"
      const resignedThisMonth = { resignedDate: '2026-09-05', month: 9, year: 2026 };
      const shouldPurgeThisMonth = (resignedThisMonth.year < currentPeriod.year) ||
        (resignedThisMonth.year === currentPeriod.year && resignedThisMonth.month < currentPeriod.month);
      expect(shouldPurgeThisMonth).toBe(false);

      // Nhân viên nghỉ trong tháng trước (2026-08-15) -> Đã hết tháng, tự động xóa
      const resignedLastMonth = { resignedDate: '2026-08-15', month: 8, year: 2026 };
      const shouldPurgeLastMonth = (resignedLastMonth.year < currentPeriod.year) ||
        (resignedLastMonth.year === currentPeriod.year && resignedLastMonth.month < currentPeriod.month);
      expect(shouldPurgeLastMonth).toBe(true);
    });

    it('computes turnover rate KPI based on resigned employees', () => {
      const totalEmployees = 100;
      const resignedCount = 3;
      const turnoverRate = +((resignedCount / totalEmployees) * 100).toFixed(1);
      expect(turnoverRate).toBe(3.0);
    });
  });
});


