import { IEmployee, IDailyTimesheetCell, IOvertimeRecord, ILeaveRequest, ISystemSettings, IProductivityQualityRate } from '../types';
import { computeEmployeeTimesheetSummary } from './formula-engine';
import { FORMULA_DEFS, PRODUCTIVITY_FORMULA, DILIGENCE_FORMULA } from './formula-defs';
import { generateCalendarDays, CalendarDay } from './calendar-utils';
import { formatPayPeriodLabel } from './pay-period';
import { getDayParts } from './day-hours';
import { DEFAULT_SETTINGS } from '../lib/defaultSettings';
import { listAll } from '../lib/tables';

type CycleMode = 'SEASONAL' | 'OFFICIAL' | 'ALL';

export async function exportTimesheetToExcel(
  employees: IEmployee[],
  timesheets: IDailyTimesheetCell[],
  overtimes: IOvertimeRecord[],
  month: number = 8,
  year: number = 2026,
  cycle: CycleMode = 'SEASONAL',
  systemSettings?: ISystemSettings,
  leaveRequests: ILeaveRequest[] = []
) {
  const settings = systemSettings || (() => { try { const raw = localStorage.getItem('smarthr_settings'); return raw ? JSON.parse(raw) as ISystemSettings : DEFAULT_SETTINGS; } catch { return DEFAULT_SETTINGS; } })();
  // đảm bảo backward compat khi settings thiếu 2 field mới
  if (!settings.productivityBonusConfig) (settings as any).productivityBonusConfig = DEFAULT_SETTINGS.productivityBonusConfig;
  if (!settings.diligenceBonusConfig) (settings as any).diligenceBonusConfig = DEFAULT_SETTINGS.diligenceBonusConfig;

  let productivityQualityRates: IProductivityQualityRate[] = [];
  try {
    productivityQualityRates = await listAll<IProductivityQualityRate>('productivityQualityRates');
  } catch (e) {
    console.warn('Failed to load productivityQualityRates for Excel export:', e);
  }

  const mod: any = await import('exceljs');
  const ExcelJSNS = mod.default ?? mod;
  const workbook = new ExcelJSNS.Workbook();
  workbook.creator = 'SmartHR Leggett & Platt';
  workbook.created = new Date();

  const officialLabel = formatPayPeriodLabel(month, year, 'OFFICIAL');
  const seasonalLabel = formatPayPeriodLabel(month, year, 'SEASONAL');

  const buildSheet = async (
    sheetName: string,
    sheetEmployees: IEmployee[],
    calendarDays: CalendarDay[],
    cycleLabel: string
  ) => {
    const ws = workbook.addWorksheet(sheetName, {
      views: [{ state: 'frozen', xSplit: 8, ySplit: 7 }],
      properties: { tabColor: { argb: cycleLabel.includes('21-20') ? 'FF002D62' : 'FF10B981' } }
    });

    // Metadata header rows — chuẩn layout file gốc
    ws.getRow(1).height = 6;
    // Logo — đường dẫn tương đối để sống được cả file:// (OneDrive offline) lẫn sub-path
    try {
      const response = await fetch('./Leggett.jpg');
      if (response.ok) {
        const blob = await response.blob();
        const arrayBuffer = await blob.arrayBuffer();
        const imageId = workbook.addImage({ buffer: arrayBuffer, extension: 'jpeg' });
        ws.addImage(imageId, { tl: { col: 0.2, row: 0.2 }, ext: { width: 180, height: 45 } });
      }
    } catch {}

    // Title Row 2 — hòa chuẩn file gốc, mở rộng theo layout 3 cột/ngày (tới cột DT=124)
    ws.mergeCells('F2:DT2');
    const titleCell = ws.getCell('F2');
    const monthStr = String(month).padStart(2, '0');
    titleCell.value = `BẢNG CHẤM CÔNG THÁNG ${monthStr}/${year} — ${cycleLabel.toUpperCase()} — TIMESHEET`;
    titleCell.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF002D62' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 22;

    // Row 3 — mô tả kỳ công thông minh + metadata
    ws.mergeCells('A3:DT3');
    const metaCell = ws.getCell('A3');
    metaCell.value = `Kỳ công: Chính thức 21-20 = ${officialLabel}  |  Thời vụ 1-31 = ${seasonalLabel}  |  Đang xuất: ${cycleLabel}  |  Tổng ${sheetEmployees.length} NV • Xuất lúc ${new Date().toLocaleString('vi-VN')} • Lọc: ${monthStr}/${year}`;
    metaCell.font = { name: 'Arial', size: 8, italic: true, color: { argb: 'FF475569' } };
    metaCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    ws.getRow(3).height = 14;

    // Row 4 — legend (như file gốc)
    ws.getCell('C4').value = "Employees under Bau Bang factory's payroll";
    ws.getCell('C4').font = { name: 'Arial', size: 8, italic: true, color: { argb: 'FF64748B' } };
    ws.getCell('D4').value = 'N: Làm việc ca đêm';
    ws.getCell('D4').font = { name: 'Arial', size: 8, color: { argb: 'FF3730A3' } };
    ws.getCell('E4').value = 'AL: Nghỉ phép năm';
    ws.getCell('E4').font = { name: 'Arial', size: 8, color: { argb: 'FF1E40AF' } };
    ws.getCell('G4').value = 'UL: Nghỉ không lương';
    ws.getCell('G4').font = { name: 'Arial', size: 8, color: { argb: 'FF475569' } };
    ws.getCell('H4').value = `Đoàn phí: ${settings.tradeUnionFee?.toLocaleString() || '40,000'}đ • Chuyên cần: ${settings.diligenceBonusConfig.baseAmount.toLocaleString()}đ (Off+UL xét trừ) • Năng suất Nhóm 2 chuẩn 1.000.000đ`;
    ws.getCell('H4').font = { name: 'Arial', size: 7, color: { argb: 'FF64748B' } };
    ws.getRow(4).height = 12;

    const fixedCols = [
      { header: 'No./\nSTT', key: 'stt', width: 6 },
      { header: 'Employee ID /\nMã nhân viên', key: 'empId', width: 14 },
      { header: 'Mã chấm công /\nERP ID', key: 'erpId', width: 12 },
      { header: 'Name /\nTên nhân viên', key: 'name', width: 22 },
      { header: 'Dept/\nBộ phận', key: 'dept', width: 13 },
      { header: 'Position/\nChức vụ', key: 'pos', width: 20 },
      { header: 'Start Date\nNgày bắt đầu', key: 'start', width: 12 },
      { header: 'Khóa\nKey', key: 'key', width: 14 }
    ];

    fixedCols.forEach((col, idx) => {
      ws.mergeCells(5, idx + 1, 7, idx + 1);
      const cell = ws.getCell(5, idx + 1);
      cell.value = col.header;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.font = { name: 'Arial', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      ws.getColumn(idx + 1).width = col.width;
    });

    // Calendar 31 days × 3 cột (Giờ làm / Phép / Tăng ca) — base 6 + dayIndex*3
    // (dayIndex 1..31 → ngày 1 ở cột 9-11, ngày 31 ở cột 99-101)
    calendarDays.forEach((day) => {
      const base = 6 + day.dayIndex * 3;
      const borderThin = { top: { style: 'thin', color: { argb: 'FFCBD5E1' } }, left: { style: 'thin', color: { argb: 'FFCBD5E1' } }, right: { style: 'thin', color: { argb: 'FFCBD5E1' } }, bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } } as any;

      ws.mergeCells(5, base, 5, base + 2);
      const cell5 = ws.getCell(5, base);
      cell5.value = `${day.dayNum}/${String(day.monthNum).padStart(2, '0')}`;
      cell5.font = { name: 'Arial', size: 9, bold: true };
      cell5.alignment = { horizontal: 'center', vertical: 'middle' };
      cell5.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
      cell5.border = borderThin;

      ws.mergeCells(6, base, 6, base + 2);
      const cell6 = ws.getCell(6, base);
      cell6.value = day.dayEn;
      cell6.font = { name: 'Arial', size: 8 };
      cell6.alignment = { horizontal: 'center', vertical: 'middle' };
      cell6.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };

      const subs = ['Giờ', 'Phép', 'TC'];
      subs.forEach((s, i) => {
        const c = ws.getCell(7, base + i);
        c.value = s;
        c.font = { name: 'Arial', size: 8, bold: true };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.border = borderThin;
      });

      if (day.isSunday) {
        cell5.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFED7AA' } };
        cell6.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFED7AA' } };
        subs.forEach((_, i) => {
          ws.getCell(7, base + i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFED7AA' } };
        });
      }
      ws.getColumn(base).width = 6;
      ws.getColumn(base + 1).width = 7;
      ws.getColumn(base + 2).width = 6;
    });

    // Summary bắt đầu sau 31×3 cột ngày: 6+31*3+1 = 102
    const SUMMARY_BASE = 102;

    // Summary headers (col 40-62) — đã bỏ các ký hiệu AN, AO, AW=..., AX, AY, AZ, BA, BB
    const summaryHeaders = [
      'Total Standard WD\nCông chuẩn',
      'Total WD\nCông thực tế',
      'Total AL\nPhép năm',
      'Total Off\nKhông phép',
      'Total UL\nKhông lương',
      'Total ML\nThai sản',
      'Total BT\nCông tác',
      'Total PH\nNghỉ lễ',
      'Total SL\nNghỉ ốm',
      'Total PL\nPhép chế độ',
      'Số ngày làm ban đêm\nNight Shifts',
      'Đi trễ về sớm\nLate/Early',
      'Thưởng năng suất\nPerformance Bonus',
      'Tiền chuyên cần\nDiligence Allowance',
      'Thưởng thêm\nExtra Bonus',
      'Tiền độc hại\nHazardous Allowance',
      'Tiền trợ cấp PCCC\nFirefighting Allowance',
      'Các chi phí khác\nOther fees',
      'Trừ đoàn phí\nTrade Union fee',
      'Tháng\nMonth',
      'Năm\nYear',
      'Ghi chú\nRemarks',
      'BaseRate Năng suất (ẩn)\nBaseRate (hidden)'
    ];

    summaryHeaders.forEach((hdr, idx) => {
      const colIdx = SUMMARY_BASE + idx;
      ws.mergeCells(5, colIdx, 7, colIdx);
      const cell = ws.getCell(5, colIdx);
      cell.value = hdr;
      const isProd = idx === 12;
      const isDilig = idx === 13;
      const isExtra = idx === 14;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isProd ? 'FF065F46' : isDilig ? 'FF92400E' : isExtra ? 'FF047857' : 'FF002D62' } };
      cell.font = { name: 'Arial', size: 8, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      ws.getColumn(colIdx).width = idx === 22 ? 18 : (idx >= 12 && idx <= 18 ? 13 : 11);
    });

    // Ẩn cột BaseRate ẩn (SUMMARY_BASE+22 = 124)
    ws.getColumn(SUMMARY_BASE + 22).hidden = true;

    // Dữ liệu NV
    const timesheetCellMap = new Map<string, IDailyTimesheetCell>();
    timesheets.forEach(c => timesheetCellMap.set(c.employeeId_date, c));
    const overtimeCellMap = new Map<string, IOvertimeRecord>();
    overtimes.forEach(o => overtimeCellMap.set(o.employeeId_date, o));
    const leaveCellMap = new Map<string, ILeaveRequest>();
    leaveRequests.forEach(r => leaveCellMap.set(`${r.employeeId}_${r.date}`, r));

    // Tính tỷ lệ trung bình % NS và % CL của từng chuyền sản xuất trong kỳ của sheet
    const lineAverageRatesMap = (() => {
      const stats = new Map<string, { sumNS: number; countNS: number; sumCL: number; countCL: number }>();
      const activeDates = new Set(calendarDays.map(d => d.dateStr));

      productivityQualityRates.forEach(r => {
        if (activeDates.has(r.date)) {
          let entry = stats.get(r.lineId);
          if (!entry) {
            entry = { sumNS: 0, countNS: 0, sumCL: 0, countCL: 0 };
            stats.set(r.lineId, entry);
          }
          if (r.productivityRate != null) { entry.sumNS += r.productivityRate; entry.countNS++; }
          if (r.qualityRate != null) { entry.sumCL += r.qualityRate; entry.countCL++; }
        }
      });

      const result = new Map<string, { avgNS: number; avgCL: number }>();
      stats.forEach((v, k) => {
        result.set(k, {
          avgNS: v.countNS > 0 ? Math.round(v.sumNS / v.countNS) : 100,
          avgCL: v.countCL > 0 ? Math.round(v.sumCL / v.countCL) : 98
        });
      });
      return result;
    })();

    sheetEmployees.forEach((emp, empIdx) => {
      const r = 8 + empIdx;
      const empCells: IDailyTimesheetCell[] = [];
      for (const day of calendarDays) {
        const k = `${emp.employeeId}_${day.dateStr}`;
        const cd = timesheetCellMap.get(k);
        if (cd) empCells.push(cd);
      }
      const deptRule = settings.diligenceDeductionRules.find(x => x.department === emp.department) || settings.diligenceDeductionRules.find(x => x.department === 'ALL') || settings.diligenceDeductionRules[0];
      const prodBase = settings.productivityBonusConfig.useDepartmentOverride && settings.productivityBonusConfig.departmentBaseRates?.[emp.department] != null
        ? settings.productivityBonusConfig.departmentBaseRates[emp.department]!
        : (emp.customAllowances?.productivityBonus || settings.productivityBonusConfig.defaultBaseRate);
      const diligenceBase = emp.customAllowances?.diligenceBonus || settings.diligenceBonusConfig.baseAmount;
      const lineRates = emp.productionLine ? lineAverageRatesMap.get(emp.productionLine) : undefined;

      const summary = computeEmployeeTimesheetSummary(emp, empCells, {
        diligenceRules: deptRule ? { twoDaysULPenaltyPct: deptRule.twoDaysULPenaltyPct, threeDaysULPenaltyPct: deptRule.threeDaysULPenaltyPct } : undefined,
        diligenceBaseAmount: diligenceBase,
        countOffAsUL: settings.diligenceBonusConfig?.countOffAsUL ?? true,
        productivityBaseRate: prodBase,
        productivityConfig: settings.productivityBonusConfig,
        lineProductivityRate: lineRates?.avgNS,
        lineQualityRate: lineRates?.avgCL,
        tradeUnionFee: settings.tradeUnionFee ?? 40000,
        extraBonus: emp.customAllowances?.extraBonus ?? 0
      });

      ws.getCell(r, 1).value = empIdx + 1;
      ws.getCell(r, 2).value = emp.employeeId;
      ws.getCell(r, 3).value = emp.erpId || '';
      ws.getCell(r, 4).value = emp.fullName;
      ws.getCell(r, 5).value = emp.department;
      ws.getCell(r, 6).value = emp.position;
      ws.getCell(r, 7).value = emp.startDate;
      ws.getCell(r, 8).value = `${emp.employeeId}_${month}`;

      for (const day of calendarDays) {
        const base = 6 + day.dayIndex * 3;
        const key = `${emp.employeeId}_${day.dateStr}`;
        const cellData = timesheetCellMap.get(key);
        const otData = overtimeCellMap.get(key);
        const leaveData = leaveCellMap.get(key);
        const parts = getDayParts(emp, cellData, otData ?? null, leaveData, day.isSunday);

        // Sub 0 — Giờ làm
        const cWork = ws.getCell(r, base);
        cWork.alignment = { horizontal: 'center', vertical: 'middle' };
        cWork.font = { name: 'Arial', size: 9 };
        if (parts.worked !== null) {
          cWork.value = parts.worked;
          cWork.numFmt = '0.0';
          if (parts.isFullLegalLeave) {
            cWork.font = { name: 'Arial', size: 9, color: { argb: 'FF64748B' } } as any;
          } else if (parts.worked >= 8) {
            cWork.font = { name: 'Arial', size: 9, color: { argb: 'FF065F46' }, bold: true } as any;
            cWork.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECFDF5' } };
          } else if (parts.worked >= 6) {
            cWork.font = { name: 'Arial', size: 9, color: { argb: 'FF9A3412' }, bold: true } as any;
            cWork.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEDD5' } };
          } else {
            cWork.font = { name: 'Arial', size: 9, color: { argb: 'FF991B1B' }, bold: true } as any;
            cWork.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
          }
        }

        // Sub 1 — Phép
        const cLeave = ws.getCell(r, base + 1);
        cLeave.alignment = { horizontal: 'center', vertical: 'middle' };
        cLeave.font = { name: 'Arial', size: 8 };
        if (parts.leave) {
          cLeave.value = parts.leave.text;
          const lt = parts.leave.leaveType;
          const argb =
            lt === 'AL' ? 'FF1E40AF' :
            lt === 'UL' ? 'FF475569' :
            lt === 'SL' ? 'FF9D174D' :
            lt === 'PL' ? 'FF0F766E' :
            lt === 'PH' ? 'FF92400E' :
            lt === 'BT' ? 'FF0284C7' :
            lt === 'ML' ? 'FF6B21A8' :
            parts.leave.tone === 'rejected' ? 'FF991B1B' : 'FF92400E';
          cLeave.font = { name: 'Arial', size: 8, color: { argb }, bold: true } as any;
          if (parts.leave.tone === 'pending') {
            cLeave.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
          }
        }

        // Sub 2 — Tăng ca (logic Overtime Table)
        const cOt = ws.getCell(r, base + 2);
        cOt.alignment = { horizontal: 'center', vertical: 'middle' };
        cOt.font = { name: 'Arial', size: 9 };
        const otH = parts.ot?.hours || 0;
        if (otH > 0) {
          cOt.value = otH;
          cOt.numFmt = '0.00';
          if (parts.ot?.verificationStatus === 'MATCHED') {
            cOt.font = { name: 'Arial', size: 9, color: { argb: 'FF065F46' }, bold: true } as any;
            cOt.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
          } else if (parts.ot?.verificationStatus === 'MISMATCH') {
            cOt.font = { name: 'Arial', size: 9, color: { argb: 'FF991B1B' }, bold: true } as any;
            cOt.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
          } else {
            cOt.font = { name: 'Arial', size: 9, color: { argb: 'FF92400E' }, bold: true } as any;
            cOt.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
          }
          const bits = [
            `Tăng ca ${otH}h (${parts.ot?.rawMinutes || Math.round(otH * 60)} phút)`,
            parts.ot?.verificationStatus,
            parts.ot?.note ? `Ghi chú: ${parts.ot.note}` : '',
          ].filter(Boolean).join(' | ');
          cOt.note = bits;
        }
        if (cellData?.violationNote) cWork.note = cellData.violationNote;
      }

      // Summary columns (SUMMARY_BASE..SUMMARY_BASE+22)
      const S = SUMMARY_BASE;
      ws.getCell(r, S).value = summary.standardWD;
      ws.getCell(r, S).numFmt = '0';
      ws.getCell(r, S + 1).value = summary.actualWD;
      ws.getCell(r, S + 2).value = summary.annualLeaveAL;
      ws.getCell(r, S + 3).value = summary.unexcusedAbsenceOff;
      ws.getCell(r, S + 4).value = summary.unpaidLeaveUL;
      ws.getCell(r, S + 5).value = summary.maternityLeaveML;
      ws.getCell(r, S + 6).value = summary.businessTripBT;
      ws.getCell(r, S + 7).value = summary.publicHolidayPH;
      ws.getCell(r, S + 8).value = summary.sickLeaveSL;
      ws.getCell(r, S + 9).value = summary.specialPaidLeavePL;
      ws.getCell(r, S + 10).value = summary.nightShiftsCount;
      ws.getCell(r, S + 11).value = summary.lateEarlyMinutes > 0 ? summary.lateEarlyMinutes : '';
      ws.getCell(r, S + 12).value = summary.productivityBonus || '';
      ws.getCell(r, S + 12).numFmt = '#,##0';
      ws.getCell(r, S + 13).value = summary.diligenceBonus || '';
      ws.getCell(r, S + 13).numFmt = '#,##0';
      ws.getCell(r, S + 14).value = summary.extraBonus || '';
      ws.getCell(r, S + 14).numFmt = '#,##0';
      ws.getCell(r, S + 15).value = summary.hazardousAllowance || '';
      ws.getCell(r, S + 15).numFmt = '#,##0';
      ws.getCell(r, S + 16).value = summary.pcccAllowance || '';
      ws.getCell(r, S + 16).numFmt = '#,##0';
      ws.getCell(r, S + 17).value = summary.otherFees || '';
      ws.getCell(r, S + 17).numFmt = '#,##0';
      ws.getCell(r, S + 18).value = summary.tradeUnionFee || '';
      ws.getCell(r, S + 18).numFmt = '#,##0';
      ws.getCell(r, S + 19).value = month;
      ws.getCell(r, S + 20).value = year;
      ws.getCell(r, S + 21).value = emp.notes || '';
      ws.getCell(r, S + 22).value = prodBase;
      ws.getCell(r, S + 22).numFmt = '#,##0';

      // Borders + number formats
      for (let c = 1; c <= SUMMARY_BASE + 22; c++) {
        const cell = ws.getCell(r, c);
        cell.border = { top: { style: 'thin', color: { argb: 'FFE2E8F0' } }, left: { style: 'thin', color: { argb: 'FFE2E8F0' } }, bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } }, right: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
        if (c >= SUMMARY_BASE && c <= SUMMARY_BASE + 11) cell.numFmt = '0.0';
      }
      // Tô màu dòng theo contract
      if (emp.contractType === 'SEASONAL') {
        ws.getCell(r, 5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } };
      }
    });

    // Footer tổng hợp
    const footerRow = 8 + sheetEmployees.length + 1;
    ws.mergeCells(footerRow, 1, footerRow, 8);
    const foot = ws.getCell(footerRow, 1);
    foot.value = `Tổng ${sheetEmployees.length} nhân viên • Kỳ ${cycleLabel} • BaseRate năng suất ẩn (cột 124) • Chuyên cần xét trừ cộng dồn Off & UL`;
    foot.font = { name: 'Arial', size: 7, italic: true, color: { argb: 'FF64748B' } };
    foot.alignment = { horizontal: 'left', vertical: 'middle' };

    // Print setup
    ws.pageSetup = { orientation: 'landscape', fitToPage: true, paperSize: 9 } as any;
    ws.properties.defaultRowHeight = 13;
  };

  if (cycle === 'ALL') {
    const officialEmps = employees.filter(e => e.contractType === 'OFFICIAL');
    const seasonalEmps = employees.filter(e => e.contractType === 'SEASONAL');
    // Nếu lọc theo dept, employees đã được lọc từ caller, nhưng vẫn tách
    const offCount = officialEmps.length;
    const seasCount = seasonalEmps.length;
    const offDays = generateCalendarDays(month, year, 'OFFICIAL');
    const seaDays = generateCalendarDays(month, year, 'SEASONAL');
    if (offCount > 0) await buildSheet(`Chính thức 21-20 (${String(month).padStart(2,'0')}/${year})`, officialEmps, offDays, `Chính thức 21-20 — ${officialLabel}`);
    if (seasCount > 0) await buildSheet(`Thời vụ 1-31 (${String(month).padStart(2,'0')}/${year})`, seasonalEmps, seaDays, `Thời vụ 1-31 — ${seasonalLabel}`);
    if (offCount === 0 && seasCount === 0) {
      // fallback single sheet
      await buildSheet(`Tổng hợp ${String(month).padStart(2,'0')}/${year}`, employees, generateCalendarDays(month, year, 'SEASONAL'), `Tổng hợp — ${seasonalLabel}`);
    }
  } else {
    const days = generateCalendarDays(month, year, cycle);
    const label = cycle === 'OFFICIAL' ? `Chính thức 21-20 — ${officialLabel}` : `Thời vụ 1-31 — ${seasonalLabel}`;
    const shName = cycle === 'OFFICIAL' ? `Chính thức 21-20` : `Thời vụ 1-31`;
    await buildSheet(shName, employees, days, label);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const suffix = cycle === 'ALL' ? `ALL_${officialLabel.replace(/\//g,'-').replace(/ /g,'')}_VA_${seasonalLabel.replace(/\//g,'-').replace(/ /g,'')}` : `${String(month).padStart(2,'0')}.${year}_${cycle}`;
  anchor.download = `KIEM_TRA_CHOT_CONG_${suffix}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
