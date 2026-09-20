import { db, DEFAULT_SETTINGS } from '../db';
import { runWithoutLanPush } from './lan-push-guard';
import initialEmployees from '../data/initial-employees.json';
import initialTimesheets from '../data/initial-timesheets.json';
import initialOvertimes from '../data/initial-overtimes.json';
import { IEmployee, IDailyTimesheetCell, IOvertimeRecord, IShiftRosterEntry, ILeaveRequest } from '../types';

export async function seedDatabaseIfEmpty() {
  const empCount = await db.employees.count();
  if (empCount === 0) {
    console.log('Seeding Dexie.js database with initial Leggett & Platt data...');
    
    // LAN push: seed dữ liệu mẫu ban đầu → KHÔNG đẩy lên LAN.
    await runWithoutLanPush(() => db.transaction('rw', [db.employees, db.dailyTimesheets, db.overtimeRecords, db.shiftRosters, db.leaveRequests], async () => {
      // Seed employees
      await db.employees.bulkPut(initialEmployees as unknown as IEmployee[]);
      
      // Seed timesheets
      await db.dailyTimesheets.bulkPut(initialTimesheets as unknown as IDailyTimesheetCell[]);
      
      // Seed overtimes
      await db.overtimeRecords.bulkPut(initialOvertimes as unknown as IOvertimeRecord[]);
      
      // Seed initial shift rosters and detect rest violations
      const shiftRosters: IShiftRosterEntry[] = [];
      const leaveRequests: ILeaveRequest[] = [];

      // Let's create some sample shift rotations including a 12h rest violation test case
      const prodEmps = (initialEmployees as unknown as IEmployee[]).filter(e => e.department === 'Production');
      
      prodEmps.slice(0, 15).forEach((emp, idx) => {
        // Day 1 (2026-07-21): Shift 2 (14:00 - 22:00)
        shiftRosters.push({
          employeeId_date: `${emp.employeeId}_2026-07-21`,
          employeeId: emp.employeeId,
          fullName: emp.fullName,
          department: emp.department,
          date: '2026-07-21',
          shiftCode: 'SHIFT_2',
          startTime: '14:00',
          endTime: '22:00',
          isRestViolation: false,
          isRestViolationFlag: 0
        });

        // Day 2 (2026-07-22): If idx < 3, rotate to Shift 1 (06:00 - 14:00) -> 8h rest -> VIOLATION!
        const isViolating = idx < 3;
        shiftRosters.push({
          employeeId_date: `${emp.employeeId}_2026-07-22`,
          employeeId: emp.employeeId,
          fullName: emp.fullName,
          department: emp.department,
          date: '2026-07-22',
          shiftCode: isViolating ? 'SHIFT_1' : 'SHIFT_2',
          startTime: isViolating ? '06:00' : '14:00',
          endTime: isViolating ? '14:00' : '22:00',
          previousShiftEndTime: '22:00',
          restHours: isViolating ? 8 : 16,
          isRestViolation: isViolating,
          isRestViolationFlag: isViolating ? 1 : 0,
          violationDetails: isViolating ? 'Nghỉ 8 giờ giữa Ca 2 (kết thúc 22h) và Ca 1 (bắt đầu 06h) < 12h quy định' : undefined
        });
      });

      // Populate initial pending leave requests for employees with 'Off' or 'UL'
      const pendingOffs = (initialTimesheets as unknown as IDailyTimesheetCell[]).filter(t => t.statusCode === 'Off' || t.statusCode === 'UL').slice(0, 8);
      pendingOffs.forEach((item, idx) => {
        const emp = (initialEmployees as unknown as IEmployee[]).find(e => e.employeeId === item.employeeId);
        if (emp) {
          leaveRequests.push({
            id: `LEAVE_${item.employeeId}_${item.date}`,
            employeeId: item.employeeId,
            fullName: emp.fullName,
            department: emp.department,
            date: item.date,
            leaveType: 'AL',
            durationDays: 1,
            status: 'PENDING',
            reason: 'Vắng mặt không quẹt thẻ ngày làm việc, chờ bù phép'
          });
        }
      });

      await db.shiftRosters.bulkPut(shiftRosters);
      await db.leaveRequests.bulkPut(leaveRequests);
    }));

    console.log('Database seeded successfully!');
  }

  // Đảm bảo overtimeRecords luôn có dữ liệu đối soát chuẩn dù employees đã tồn tại trước đó
  const otCount = await db.overtimeRecords.count();
  if (otCount === 0) {
    await db.overtimeRecords.bulkPut(initialOvertimes as unknown as IOvertimeRecord[]);
  }

  // Đảm bảo dailyTimesheets luôn có dữ liệu quẹt thẻ chuẩn
  const tsCount = await db.dailyTimesheets.count();
  if (tsCount === 0) {
    await db.dailyTimesheets.bulkPut(initialTimesheets as unknown as IDailyTimesheetCell[]);
  }

  // v5: đảm bảo shiftClasses + rbacRoles luôn có seed dù upgrade không chạy (fresh install cũ bỏ qua version)
  const scCount = await db.shiftClasses.count();
  if (scCount === 0) {
    const now = new Date().toISOString();
    await db.shiftClasses.bulkPut([
      { shiftClassId: 'OFFICE_M_F', labelVi: 'HC Văn phòng (T2-T6 | 23 công)', labelEn: 'Office Mon-Fri (23 WDs)', startTime: '07:30', endTime: '16:00', standardWorkDays: 23, workDaysPattern: 'MON_FRI', isRotating: false, isRotatingFlag: 0, description: 'Hành chính văn phòng Thứ 2-6', color: '#3B82F6', createdAt: now },
      { shiftClassId: 'OFFICE_M_S', labelVi: 'HC Chung (T2-T7 | 27 công)', labelEn: 'Office Mon-Sat (27 WDs)', startTime: '07:30', endTime: '16:00', standardWorkDays: 27, workDaysPattern: 'MON_SAT', isRotating: false, isRotatingFlag: 0, description: 'Hành chính chung Thứ 2-7', color: '#64748B', createdAt: now },
      { shiftClassId: 'SHIFT_1', labelVi: 'Ca 1 (06:00 - 14:00)', labelEn: 'Shift 1 (06:00 - 14:00)', startTime: '06:00', endTime: '14:00', standardWorkDays: 27, workDaysPattern: 'ROTATING', isRotating: true, isRotatingFlag: 1, description: 'Xoay ca sáng', color: '#6366F1', createdAt: now },
      { shiftClassId: 'SHIFT_2', labelVi: 'Ca 2 (14:00 - 22:00)', labelEn: 'Shift 2 (14:00 - 22:00)', startTime: '14:00', endTime: '22:00', standardWorkDays: 27, workDaysPattern: 'ROTATING', isRotating: true, isRotatingFlag: 1, description: 'Xoay ca chiều', color: '#EC4899', createdAt: now }
    ] as any);
  }
  const roleCount = await db.rbacRoles.count();
  if (roleCount === 0) {
    const now = new Date().toISOString();
    const perms = DEFAULT_SETTINGS.rolePermissions as Record<string, string[]>;
    const roles: any[] = Object.entries(perms).map(([roleId, permissions]) => ({
      roleId,
      roleName: roleId,
      description: roleId === 'AD System' ? 'Super Admin — toàn quyền hệ thống' : roleId === 'HR Manager' ? 'HR Manager — toàn quyền HR' : `${roleId} — quyền theo phòng ban`,
      permissions,
      departmentScope: roleId.includes('Warehouse') ? 'WH' : roleId.includes('Production') ? 'Production' : roleId.includes('QC') ? 'QC' : null,
      isSystem: true,
      isSystemFlag: 1 as const,
      createdAt: now
    }));
    await db.rbacRoles.bulkPut(roles);
  }
  // v7: đảm bảo productionLines luôn có 2 line mặc định dù là fresh install
  const plCount = await db.productionLines.count();
  if (plCount === 0) {
    const now = new Date().toISOString();
    await db.productionLines.bulkPut([
      { id: 'line_rivet_1', name: 'Line Rivet 1', description: 'Chuyền đinh tán số 1', createdAt: now },
      { id: 'line_rivet_2', name: 'Line Rivet 2', description: 'Chuyền đinh tán số 2', createdAt: now }
    ]);
  }
  // v6: backfill Flag cho dữ liệu cũ nếu thiếu (phòng upgrade chưa chạy trong test fake-indexeddb)
  await db.dailyTimesheets.toCollection().modify((rec: any) => { if (typeof rec.isViolationFlag === 'undefined') rec.isViolationFlag = rec.isViolation ? 1 : 0; }).catch(() => {});
  await db.shiftRosters.toCollection().modify((rec: any) => { if (typeof rec.isRestViolationFlag === 'undefined') rec.isRestViolationFlag = rec.isRestViolation ? 1 : 0; }).catch(() => {});
  await db.accounts.toCollection().modify((rec: any) => { if (typeof rec.activeFlag === 'undefined') rec.activeFlag = rec.active ? 1 : 0; }).catch(() => {});
  await db.shiftClasses.toCollection().modify((rec: any) => { if (typeof rec.isRotatingFlag === 'undefined') rec.isRotatingFlag = rec.isRotating ? 1 : 0; }).catch(() => {});
  await db.rbacRoles.toCollection().modify((rec: any) => { if (typeof rec.isSystemFlag === 'undefined') rec.isSystemFlag = rec.isSystem ? 1 : 0; }).catch(() => {});
}
