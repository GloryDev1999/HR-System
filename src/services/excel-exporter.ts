import { IEmployee, IDailyTimesheetCell, IOvertimeRecord, ISystemSettings, IProductivityQualityRate } from '../types';
import { computeEmployeeTimesheetSummary } from './formula-engine';
import { FORMULA_DEFS, PRODUCTIVITY_FORMULA, DILIGENCE_FORMULA } from './formula-defs';
import { generateCalendarDays, CalendarDay } from './calendar-utils';
import { formatPayPeriodLabel } from './pay-period';
import { DEFAULT_SETTINGS } from '../lib/defaultSettings';
import { listAll } from '../lib/tables';

type CycleMode = 'SEASONAL' | 'OFFICIAL' | 'ALL';

export async function exportTimesheetToExcel(
  employees: IEmployee[],
  timesheets: IDailyTimesheetCell[],
  _overtimes: IOvertimeRecord[],
  month: number = 8,
  year: number = 2026,
  cycle: CycleMode = 'SEASONAL',
  systemSettings?: ISystemSettings
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

    // Title Row 2 — hòa chuẩn file gốc F2:AM2
    ws.mergeCells('F2:AM2');
    const titleCell = ws.getCell('F2');
    const monthStr = String(month).padStart(2, '0');
    titleCell.value = `BẢNG CHẤM CÔNG THÁNG ${monthStr}/${year} — ${cycleLabel.toUpperCase()} — TIMESHEET`;
    titleCell.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF002D62' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 22;

    // Row 3 — mô tả kỳ công thông minh + metadata
    ws.mergeCells('A3:BF3');
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

    // Calendar 31 days — chuẩn gốc I:AM
    calendarDays.forEach((day) => {
      const colIdx = 8 + day.dayIndex;
      const cell5 = ws.getCell(5, colIdx);
      cell5.value = `${day.dayNum}/${String(day.monthNum).padStart(2, '0')}`;
      cell5.font = { name: 'Arial', size: 9, bold: true };
      cell5.alignment = { horizontal: 'center', vertical: 'middle' };
      cell5.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
      cell5.border = { top: { style: 'thin', color: { argb: 'FFCBD5E1' } }, left: { style: 'thin', color: { argb: 'FFCBD5E1' } }, right: { style: 'thin', color: { argb: 'FFCBD5E1' } }, bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };

      const cell6 = ws.getCell(6, colIdx);
      cell6.value = day.dayEn;
      cell6.font = { name: 'Arial', size: 8 };
      cell6.alignment = { horizontal: 'center', vertical: 'middle' };
      cell6.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };

      const cell7 = ws.getCell(7, colIdx);
      cell7.value = day.dayVi;
      cell7.font = { name: 'Arial', size: 8, bold: true };
      cell7.alignment = { horizontal: 'center', vertical: 'middle' };

      if (day.isSunday) {
        cell5.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFED7AA' } };
        cell6.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFED7AA' } };
        cell7.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFED7AA' } };
      }
      ws.getColumn(colIdx).width = 5.5;
    });

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
      const colIdx = 40 + idx;
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

    // Ẩn cột BaseRate ẩn (62)
    ws.getColumn(62).hidden = true;

    // Dữ liệu NV
    const timesheetCellMap = new Map<string, IDailyTimesheetCell>();
    timesheets.forEach(c => timesheetCellMap.set(c.employeeId_date, c));

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
        const colIdx = 8 + day.dayIndex;
        const key = `${emp.employeeId}_${day.dateStr}`;
        const cellData = timesheetCellMap.get(key);
        const val = cellData?.statusCode || '';
        const cell = ws.getCell(r, colIdx);
        cell.value = val;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = { name: 'Arial', size: 9 };
        if (val === 'W') { cell.font = { color: { argb: 'FF065F46' }, bold: true } as any; }
        else if (val === 'N') { cell.font = { color: { argb: 'FF3730A3' }, bold: true } as any; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E7FF' } }; }
        else if (val === 'Off' || val === 'OFF') { cell.font = { color: { argb: 'FF991B1B' }, bold: true } as any; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }; }
        else if (val === 'AL') { cell.font = { color: { argb: 'FF1E40AF' }, bold: true } as any; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } }; }
        else if (val === 'UL') { cell.font = { color: { argb: 'FF475569' } } as any; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }; }
        else if (val === 'SL') { cell.font = { color: { argb: 'FF9D174D' }, bold: true } as any; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE7F3' } }; }
        else if (val === 'PL') { cell.font = { color: { argb: 'FF0F766E' }, bold: true } as any; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCFBF1' } }; }
        else if (val === 'PH') { cell.font = { color: { argb: 'FF92400E' }, bold: true } as any; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } }; }
        else if (val === 'ML' || val === 'MATERNITY LEAVE') { cell.font = { color: { argb: 'FF6B21A8' }, bold: true } as any; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3E8FF' } }; }
        else if (val === 'BT') { cell.font = { color: { argb: 'FF0284C7' }, bold: true } as any; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F2FE' } }; }
        else if (val === 'LA' || val === 'ED') { cell.font = { color: { argb: 'FF9A3412' }, bold: true } as any; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEDD5' } }; }
        else if (val === 'MCO' || val === 'MCI') { cell.font = { color: { argb: 'FF991B1B' }, bold: true } as any; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }; }
        if (cellData?.violationNote) cell.note = cellData.violationNote;
      }

      // Summary columns (40..62)
      ws.getCell(r, 40).value = summary.standardWD;
      ws.getCell(r, 40).numFmt = '0';
      ws.getCell(r, 41).value = summary.actualWD;
      ws.getCell(r, 42).value = summary.annualLeaveAL;
      ws.getCell(r, 43).value = summary.unexcusedAbsenceOff;
      ws.getCell(r, 44).value = summary.unpaidLeaveUL;
      ws.getCell(r, 45).value = summary.maternityLeaveML;
      ws.getCell(r, 46).value = summary.businessTripBT;
      ws.getCell(r, 47).value = summary.publicHolidayPH;
      ws.getCell(r, 48).value = summary.sickLeaveSL;
      ws.getCell(r, 49).value = summary.specialPaidLeavePL;
      ws.getCell(r, 50).value = summary.nightShiftsCount;
      ws.getCell(r, 51).value = summary.lateEarlyMinutes > 0 ? summary.lateEarlyMinutes : '';
      ws.getCell(r, 52).value = summary.productivityBonus || '';
      ws.getCell(r, 52).numFmt = '#,##0';
      ws.getCell(r, 53).value = summary.diligenceBonus || '';
      ws.getCell(r, 53).numFmt = '#,##0';
      ws.getCell(r, 54).value = summary.extraBonus || '';
      ws.getCell(r, 54).numFmt = '#,##0';
      ws.getCell(r, 55).value = summary.hazardousAllowance || '';
      ws.getCell(r, 55).numFmt = '#,##0';
      ws.getCell(r, 56).value = summary.pcccAllowance || '';
      ws.getCell(r, 56).numFmt = '#,##0';
      ws.getCell(r, 57).value = summary.otherFees || '';
      ws.getCell(r, 57).numFmt = '#,##0';
      ws.getCell(r, 58).value = summary.tradeUnionFee || '';
      ws.getCell(r, 58).numFmt = '#,##0';
      ws.getCell(r, 59).value = month;
      ws.getCell(r, 60).value = year;
      ws.getCell(r, 61).value = emp.notes || '';
      ws.getCell(r, 62).value = prodBase;
      ws.getCell(r, 62).numFmt = '#,##0';

      // Borders + number formats
      for (let c = 1; c <= 62; c++) {
        const cell = ws.getCell(r, c);
        cell.border = { top: { style: 'thin', color: { argb: 'FFE2E8F0' } }, left: { style: 'thin', color: { argb: 'FFE2E8F0' } }, bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } }, right: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
        if (c >= 40 && c <= 51) cell.numFmt = '0.0';
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
    foot.value = `Tổng ${sheetEmployees.length} nhân viên • Kỳ ${cycleLabel} • BaseRate năng suất ẩn (cột 62) • Chuyên cần xét trừ cộng dồn Off & UL`;
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
