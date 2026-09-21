import React, { useState } from 'react';
import { 
  Users, 
  Plus, 
  Search, 
  Filter, 
  Edit, 
  Trash2, 
  Flame, 
  Biohazard, 
  Award, 
  Calendar,
  CalendarDays,
  Plane,
  Briefcase,
  CheckCircle2,
  XCircle,
  FileText,
  SlidersHorizontal,
  UserMinus,
  Gift
} from 'lucide-react';
import { useLiveTable, upsertOne, updateByKey, removeByKey, bulkRemove, listWhere } from '../lib/tables';
import type { IEmployee, IProductionLine, ShiftClassType, ContractType } from '../types';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';
import { useAuth } from '../context/AuthContext';
import { daysUntil, getPayPeriod, parseDateLoose } from '../services/pay-period';

export const EmployeeListPage: React.FC = () => {
  const { success, warning, error } = useToast();
  const { confirm, openCustomModal, closeCustomModal } = useModal();
  const { currentRole, departmentScope, hasPermission } = useAuth();

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedDept, setSelectedDept] = useState<string>('ALL');
  const [selectedContract, setSelectedContract] = useState<string>('ALL');
  const [selectedShift, setSelectedShift] = useState<string>('ALL');
  const [selectedLine, setSelectedLine] = useState<string>('ALL');

  // Modal form states
  const [editingEmployee, setEditingEmployee] = useState<IEmployee | null>(null);
  const [showAddDept, setShowAddDept] = useState(false);
  const [newDeptName, setNewDeptName] = useState('');
  const [showAddPos, setShowAddPos] = useState(false);
  const [newPosName, setNewPosName] = useState('');

  // Unified Special Regime modal state (Thai sản & Đi công tác)
  const [specialModalEmp, setSpecialModalEmp] = useState<IEmployee | null>(null);
  const [specialTab, setSpecialTab] = useState<'MATERNITY' | 'BUSINESS_TRIP'>('MATERNITY');
  const [maternityActive, setMaternityActive] = useState<boolean>(false);
  const [maternityStart, setMaternityStart] = useState<string>('');
  const [maternityEnd, setMaternityEnd] = useState<string>('');
  const [tripActive, setTripActive] = useState<boolean>(false);
  const [tripStart, setTripStart] = useState<string>('');
  const [tripEnd, setTripEnd] = useState<string>('');
  const [tripLocation, setTripLocation] = useState<string>('');

  // Query live employees & production lines (Supabase realtime)
  const rawEmployees = useLiveTable<IEmployee>('employees');
  const rawProductionLines = useLiveTable<IProductionLine>('productionLines');

  // Filter based on department scope and filters
  const filteredEmployees = rawEmployees.filter(emp => {
    // Dept scope for restricted roles
    if (departmentScope && emp.department !== departmentScope) {
      return false;
    }
    if (selectedLine !== 'ALL' && emp.productionLine !== selectedLine) {
      return false;
    }
    // Search
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const matchId = emp.employeeId.toLowerCase().includes(q);
      const matchName = emp.fullName.toLowerCase().includes(q);
      const matchErp = emp.erpId?.toLowerCase().includes(q);
      if (!matchId && !matchName && !matchErp) return false;
    }
    // Dept filter
    if (selectedDept !== 'ALL' && emp.department !== selectedDept) return false;
    // Contract filter
    if (selectedContract !== 'ALL' && emp.contractType !== selectedContract) return false;
    // Shift filter
    if (selectedShift !== 'ALL' && emp.shiftClassId !== selectedShift) return false;

    return true;
  });

  const departments = Array.from(new Set(rawEmployees.map(e => e.department))).filter(Boolean);

  const handleOpenAddEditModal = (emp?: IEmployee) => {
    const defaultEmp: IEmployee = emp ? { ...emp } : {
      employeeId: `LEP${String(rawEmployees.length + 1).padStart(3, '0')}`,
      erpId: '',
      fullName: '',
      department: departmentScope || 'Production',
      position: 'Operator',
      startDate: new Date().toLocaleDateString('en-GB'),
      contractType: 'OFFICIAL',
      shiftClassId: 'OFFICE_M_S',
      customAllowances: {
        pcccAllowance: 0,
        hazardousAllowance: 0,
        diligenceBonus: 500000,
        productivityBonus: 0,
        extraBonus: 0,
        tradeUnionFee: -40000,
        otherFees: 0
      },
      annualLeaveBalance: {
        initialQuota: 12,
        usedDays: 0,
        remainingDays: 12
      },
      status: 'ACTIVE'
    };

    setEditingEmployee(defaultEmp);
  };

  const handleSaveEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasPermission('MANAGE_EMPLOYEES')) {
      error('Không đủ quyền', 'Bạn không có quyền chỉnh sửa thông tin nhân sự (MANAGE_EMPLOYEES).');
      return;
    }
    if (!editingEmployee) return;

    if (!editingEmployee.employeeId.trim() || !editingEmployee.fullName.trim()) {
      error('Thiếu thông tin bắt buộc', 'Vui lòng nhập đầy đủ Mã NV và Họ tên.');
      return;
    }

    try {
      await upsertOne('employees', editingEmployee);
      success(
        'Lưu nhân viên thành công!',
        `Đã cập nhật thông tin và phụ cấp cho nhân viên ${editingEmployee.employeeId} - ${editingEmployee.fullName}.`
      );
      setEditingEmployee(null);
    } catch (err: any) {
      error('Lỗi khi lưu nhân viên', err.message);
    }
  };

  // Tự động xóa nhân viên đã nghỉ việc khi bước sang tháng mới
  React.useEffect(() => {
    const purgeExpiredResignedEmployees = async () => {
      try {
        const allResigned = await listWhere<IEmployee>('employees', 'status', 'RESIGNED');
        if (allResigned.length === 0) return;

        const savedMonth = localStorage.getItem('smarthr_selected_month');
        const savedYear = localStorage.getItem('smarthr_selected_year');
        const curMonth = savedMonth ? parseInt(savedMonth, 10) : (new Date().getMonth() + 1);
        const curYear = savedYear ? parseInt(savedYear, 10) : new Date().getFullYear();

        const idsToDelete: string[] = [];
        for (const emp of allResigned) {
          if (!emp.resignedDate) continue;
          const d = parseDateLoose(emp.resignedDate);
          if (!d) continue;
          const pp = getPayPeriod(d, emp.contractType);
          const isPastPeriod = pp.payYear < curYear || (pp.payYear === curYear && pp.payMonth < curMonth);
          if (isPastPeriod) {
            idsToDelete.push(emp.employeeId);
          }
        }

        if (idsToDelete.length > 0) {
          await bulkRemove('employees', idsToDelete);
          console.log(`[AUTO-PURGE] Đã tự động xóa ${idsToDelete.length} nhân viên nghỉ việc từ tháng cũ:`, idsToDelete);
        }
      } catch (err) {
        console.warn('Lỗi khi tự động dọn dẹp nhân viên nghỉ việc', err);
      }
    };

    purgeExpiredResignedEmployees();
  }, []);

  const handleDeleteEmployee = async (emp: IEmployee) => {
    const today = new Date().toLocaleDateString('en-GB'); // DD/MM/YYYY

    if (emp.status === 'RESIGNED') {
      const ok = await confirm({
        title: `Xóa vĩnh viễn nhân viên [${emp.employeeId}]`,
        message: `Nhân viên [${emp.employeeId}] ${emp.fullName} hiện đang ở trạng thái "Đã nghỉ việc" (ngày ${emp.resignedDate || today}). Bạn có muốn xóa vĩnh viễn ngay lập tức khỏi hệ thống không?`,
        confirmText: 'Xóa vĩnh viễn ngay',
        cancelText: 'Hủy bỏ',
        type: 'danger'
      });
      if (ok) {
        await removeByKey('employees', emp.employeeId);
        success('Đã xóa nhân viên', `Nhân viên ${emp.employeeId} - ${emp.fullName} đã được xóa vĩnh viễn.`);
      }
      return;
    }

    const ok = await confirm({
      title: `Xác nhận xóa nhân viên [${emp.employeeId}]`,
      message: `Bạn có chắc chắn muốn xóa nhân viên [${emp.employeeId}] ${emp.fullName}? Hệ thống sẽ chuyển trạng thái sang "Đã nghỉ việc" (RESIGNED) vào ngày ${today}, đồng bộ trực tiếp tới thẻ KPI "Tỷ lệ nghỉ việc". Nhân viên sẽ tiếp tục hiển thị trạng thái "Đã nghỉ việc" cho đến hết tháng này, và sẽ được tự động xóa hoàn toàn khi bắt đầu kỳ công tháng mới.`,
      confirmText: 'Xác nhận xóa nhân viên',
      cancelText: 'Hủy bỏ',
      type: 'danger'
    });

    if (ok) {
      await updateByKey('employees', emp.employeeId, {
        status: 'RESIGNED',
        resignedDate: today
      } as any);
      success(
        'Đã xóa nhân viên (Chuyển sang Đã nghỉ việc)',
        `Nhân viên ${emp.employeeId} - ${emp.fullName} đã chuyển sang trạng thái "Đã nghỉ việc" ngày ${today}. Số liệu đã đồng bộ vào thẻ KPI Tỷ lệ nghỉ việc trên Dashboard và sẽ tự động xóa khi bắt đầu tháng mới.`
      );
    }
  };

  const handleOpenSpecialModal = (emp: IEmployee) => {
    setSpecialModalEmp(emp);
    const isMaternity = emp.status === 'MATERNITY';
    setMaternityActive(isMaternity);

    // Convert existing DD/MM/YYYY or YYYY-MM-DD to YYYY-MM-DD for input[type="date"]
    const toInputDate = (s?: string) => {
      if (!s) return '';
      if (s.includes('/')) {
        const [d, m, y] = s.split('/');
        return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      }
      return s;
    };

    const mStart = toInputDate(emp.maternityStartDate) || new Date().toISOString().slice(0, 10);
    setMaternityStart(mStart);

    if (emp.maternityEndDate) {
      setMaternityEnd(toInputDate(emp.maternityEndDate));
    } else {
      try {
        const d = new Date(mStart);
        d.setMonth(d.getMonth() + 6);
        setMaternityEnd(d.toISOString().slice(0, 10));
      } catch {
        setMaternityEnd('');
      }
    }

    const hasTrip = !!(emp.businessTripStartDate && emp.businessTripEndDate);
    setTripActive(hasTrip);
    setTripStart(toInputDate(emp.businessTripStartDate) || new Date().toISOString().slice(0, 10));
    setTripEnd(toInputDate(emp.businessTripEndDate) || new Date().toISOString().slice(0, 10));
    setTripLocation(emp.businessTripLocation || '');

    if (hasTrip && !isMaternity) {
      setSpecialTab('BUSINESS_TRIP');
    } else {
      setSpecialTab('MATERNITY');
    }
  };

  const handleSaveSpecialModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!specialModalEmp) return;
    try {
      const updates: Partial<IEmployee> = {};

      // 1. Cập nhật Thai sản
      if (maternityActive) {
        if (!maternityStart || !maternityEnd) {
          warning('Thiếu thời gian', 'Vui lòng chọn ngày bắt đầu và kết thúc nghỉ thai sản.');
          return;
        }
        updates.status = 'MATERNITY';
        updates.maternityStartDate = maternityStart;
        updates.maternityEndDate = maternityEnd;
      } else {
        if (specialModalEmp.status === 'MATERNITY') {
          updates.status = 'ACTIVE';
        }
        updates.maternityStartDate = undefined;
        updates.maternityEndDate = undefined;
      }

      // 2. Cập nhật Công tác
      if (tripActive) {
        if (!tripStart || !tripEnd) {
          warning('Thiếu thời gian', 'Vui lòng chọn ngày bắt đầu và kết thúc đi công tác.');
          return;
        }
        updates.businessTripStartDate = tripStart;
        updates.businessTripEndDate = tripEnd;
        updates.businessTripLocation = tripLocation.trim() || undefined;
      } else {
        updates.businessTripStartDate = undefined;
        updates.businessTripEndDate = undefined;
        updates.businessTripLocation = undefined;
      }

      await updateByKey('employees', specialModalEmp.employeeId, updates);
      success(
        'Lưu cấu hình thành công!',
        `Đã cập nhật chế độ Thai sản & Công tác cho nhân viên ${specialModalEmp.fullName}. Khi nạp bảng quẹt thẻ sẽ tự động áp dụng mã tương ứng (ML/BT).`
      );
      setSpecialModalEmp(null);
    } catch (err: any) {
      error('Lỗi khi lưu cấu hình', err.message);
    }
  };

  return (
    <div className="p-6 w-full space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Users className="w-5 h-5 text-orange-500" />
            <span>Danh Mục Toàn Bộ Nhân Viên</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Quản lý quan hệ ca làm việc (Hành chính T2-T6 / T2-T7, Ca 1, Ca 2), chu kỳ tính công (Thời vụ 01-31 / Chính thức 21-20), phụ cấp PCCC/Độc hại, thử việc và phép năm.
          </p>
        </div>

        {hasPermission('MANAGE_EMPLOYEES') && (
          <button
            onClick={() => handleOpenAddEditModal()}
            className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-orange-500 to-rose-500 hover:from-orange-600 hover:to-rose-600 text-white text-xs font-bold rounded-xl transition shadow-md shadow-orange-200"
          >
            <Plus className="w-4 h-4" />
            <span>Thêm Nhân Viên Mới</span>
          </button>
        )}
      </div>

      {/* Filters & Search */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
        {/* Search */}
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Tìm theo mã NV, Tên..."
            className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500"
          />
        </div>

        {/* Dept Filter */}
        <div>
          <select
            value={selectedDept}
            onChange={(e) => setSelectedDept(e.target.value)}
            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500"
          >
            <option value="ALL">Tất cả Phòng Ban ({rawEmployees.length})</option>
            {departments.map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </div>

        {/* Contract Type Filter */}
        <div>
          <select
            value={selectedContract}
            onChange={(e) => setSelectedContract(e.target.value)}
            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500"
          >
            <option value="ALL">Tất cả Hợp đồng</option>
            <option value="OFFICIAL">Chính thức (Kỳ 21 - 20)</option>
            <option value="SEASONAL">Thời vụ (Kỳ 1 - 31)</option>
          </select>
        </div>

        {/* Shift Class Filter */}
        <div>
          <select
            value={selectedShift}
            onChange={(e) => setSelectedShift(e.target.value)}
            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500"
          >
            <option value="ALL">Tất cả Nhóm Ca</option>
            <option value="OFFICE_M_F">HC Văn Phòng (T2-T6 | 23 công)</option>
            <option value="OFFICE_M_S">HC Chung (T2-T7 | 27 công)</option>
            <option value="SHIFT_1">Ca 1 (06:00 - 14:00)</option>
            <option value="SHIFT_2">Ca 2 (14:00 - 22:00)</option>
          </select>
        </div>

        {/* Line Filter */}
        <div>
          <select
            value={selectedLine}
            onChange={(e) => setSelectedLine(e.target.value)}
            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500"
          >
            <option value="ALL">Tất cả Line sản xuất</option>
            {rawProductionLines.map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Employee List Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <span>Hiển thị <b>{filteredEmployees.length}</b> / {rawEmployees.length} nhân viên</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200">
              <tr>
                <th className="py-3 px-4 whitespace-nowrap min-w-[50px]">#</th>
                <th className="py-3 px-4 whitespace-nowrap min-w-[90px]">Mã NV</th>
                <th className="py-3 px-4 whitespace-nowrap min-w-[160px]">Họ và Tên</th>
                <th className="py-3 px-4 whitespace-nowrap min-w-[150px]">Phòng Ban & Chức Vụ</th>
                <th className="py-3 px-4 text-center whitespace-nowrap min-w-[170px]">Nhóm Ca Làm Việc</th>
                <th className="py-3 px-4 text-center whitespace-nowrap min-w-[165px]">Hợp Đồng & Kỳ Công</th>
                <th className="py-3 px-4 text-center whitespace-nowrap min-w-[145px]">Chuyền & Nhóm NS</th>
                <th className="py-3 px-4 text-center whitespace-nowrap min-w-[155px]">Thời gian hợp đồng</th>
                <th className="py-3 px-4 text-center whitespace-nowrap min-w-[150px]">Phụ Cấp Gắn Riêng</th>
                <th className="py-3 px-4 text-center whitespace-nowrap min-w-[130px]">Phép Năm Còn Lại</th>
                <th className="py-3 px-4 text-center whitespace-nowrap min-w-[130px]">Trạng Thái</th>
                <th className="py-3 px-4 text-right whitespace-nowrap min-w-[110px]">Thao Tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredEmployees.map((emp, idx) => {
                const isPCCC = emp.customAllowances?.pcccAllowance > 0;
                const isHazard = emp.customAllowances?.hazardousAllowance > 0;

                return (
                  <tr key={emp.employeeId} className="hover:bg-slate-50/80 transition">
                    <td className="py-3 px-4 text-slate-400 font-medium">{idx + 1}</td>
                    <td className="py-3 px-4 font-bold text-slate-900">
                      <span className="px-2 py-0.5 rounded-lg bg-slate-100 text-slate-800 border border-slate-200">
                        {emp.employeeId}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-900">{emp.fullName}</div>
                      {emp.erpId && <div className="text-[11px] text-slate-400">ERP: {emp.erpId}</div>}
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-800">{emp.department}</div>
                      <div className="text-[11px] text-slate-500">{emp.position}</div>
                    </td>
                    <td className="py-3 px-4 text-center whitespace-nowrap min-w-[170px]">
                      {emp.shiftClassId === 'OFFICE_M_F' && (
                        <span className="px-2 py-1 rounded-full bg-blue-50 text-blue-700 font-medium whitespace-nowrap inline-block">HC T2-T6 (23 công)</span>
                      )}
                      {emp.shiftClassId === 'OFFICE_M_S' && (
                        <span className="px-2 py-1 rounded-full bg-slate-100 text-slate-700 font-medium whitespace-nowrap inline-block">HC T2-T7 (27 công)</span>
                      )}
                      {emp.shiftClassId === 'SHIFT_1' && (
                        <span className="px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 font-bold whitespace-nowrap inline-block">Ca 1 (06h - 14h)</span>
                      )}
                      {emp.shiftClassId === 'SHIFT_2' && (
                        <span className="px-2 py-1 rounded-full bg-pink-50 text-pink-700 font-bold whitespace-nowrap inline-block">Ca 2 (14h - 22h)</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center whitespace-nowrap min-w-[165px]">
                      {emp.contractType === 'OFFICIAL' ? (
                        <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 font-semibold whitespace-nowrap inline-block">
                          Chính thức (21-20)
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 border border-orange-200 font-semibold whitespace-nowrap inline-block">
                          Thời vụ (1-31)
                        </span>
                      )}
                      {emp.contractTerm && (
                        <div className="text-[10px] text-slate-500 mt-1 whitespace-nowrap">
                          {emp.contractTerm === '1_MONTH' ? 'HĐ 1 tháng' : emp.contractTerm === '2_MONTHS' ? 'HĐ 2 tháng' : emp.contractTerm === '1_YEAR' ? 'HĐ 1 năm' : emp.contractTerm === '3_YEARS' ? 'HĐ 3 năm' : 'HĐ vĩnh viễn'}
                          {emp.contractEndDate ? ` • ${emp.contractEndDate}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-center whitespace-nowrap min-w-[145px]">
                      <div className="flex flex-col items-center gap-1">
                        {emp.productionLine ? (
                          <span className="px-2 py-0.5 rounded-md bg-purple-50 text-purple-700 border border-purple-200 font-medium text-[11px] whitespace-nowrap inline-block">
                            {rawProductionLines.find(l => l.id === emp.productionLine)?.name || emp.productionLine}
                          </span>
                        ) : (
                          <span className="text-[11px] text-slate-400">—</span>
                        )}
                        {emp.productivityGroup && (
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap inline-block ${
                            emp.productivityGroup === 1
                              ? 'bg-amber-50 text-amber-700 border-amber-200'
                              : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          }`}>
                            {emp.productivityGroup === 1 ? 'Nhóm 1' : 'Nhóm 2'}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-center whitespace-nowrap min-w-[155px]">
                      {(() => {
                        const now = new Date();
                        const probDays = emp.probationEndDate ? daysUntil(emp.probationEndDate, now) : null;
                        const isProbation = probDays !== null && probDays >= 0;
                        if (isProbation && emp.probationMonths) {
                          return (
                            <>
                              <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-semibold whitespace-nowrap inline-block">
                                Thử việc {emp.probationMonths} tháng
                              </span>
                              <div className="text-[10px] text-slate-400 mt-0.5 whitespace-nowrap">đến {emp.probationEndDate}</div>
                            </>
                          );
                        }
                        // Qua thử việc: hiển thị thời hạn hợp đồng sắp tới
                        if (emp.contractEndDate) {
                          const d = daysUntil(emp.contractEndDate, now);
                          const label = emp.contractTerm === '1_MONTH' ? 'HĐ 1 tháng' : emp.contractTerm === '2_MONTHS' ? 'HĐ 2 tháng' : emp.contractTerm === '1_YEAR' ? 'HĐ 1 năm' : emp.contractTerm === '3_YEARS' ? 'HĐ 3 năm' : emp.contractTerm === 'PERMANENT' ? 'Vĩnh viễn' : 'HĐ';
                          const isUrgent = d !== null && d >= 0 && d <= 15;
                          const isWarn = d !== null && d >= 0 && d <= 30;
                          return (
                            <>
                              <span className={`px-2 py-0.5 rounded-full border font-semibold whitespace-nowrap inline-block ${isUrgent ? 'bg-rose-50 text-rose-700 border-rose-200' : isWarn ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-blue-50 text-blue-700 border-blue-200'}`}>
                                {label}
                              </span>
                              <div className="text-[10px] text-slate-500 mt-0.5 whitespace-nowrap">{emp.contractEndDate} {d !== null && d >= 0 ? `• còn ${d} ngày` : d !== null && d < 0 ? '• đã hết hạn' : ''}</div>
                            </>
                          );
                        }
                        if (emp.contractTerm) {
                          const label = emp.contractTerm === '1_MONTH' ? 'HĐ 1 tháng' : emp.contractTerm === '2_MONTHS' ? 'HĐ 2 tháng' : emp.contractTerm === '1_YEAR' ? 'HĐ 1 năm' : emp.contractTerm === '3_YEARS' ? 'HĐ 3 năm' : 'Vĩnh viễn';
                          return <span className="px-2 py-0.5 rounded-full bg-slate-50 text-slate-700 border font-medium whitespace-nowrap inline-block">{label}</span>;
                        }
                        return <span className="text-slate-400 text-[11px]">—</span>;
                      })()}
                    </td>
                    <td className="py-3 px-4 text-center whitespace-nowrap min-w-[150px]">
                      <div className="flex items-center justify-center gap-1.5 flex-wrap">
                        {isPCCC && (
                          <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 font-bold border border-amber-200 flex items-center gap-1 whitespace-nowrap" title={`Trợ cấp PCCC: ${emp.customAllowances.pcccAllowance.toLocaleString()} VNĐ`}>
                            <Flame className="w-3 h-3 text-amber-600" />
                            PCCC
                          </span>
                        )}
                        {isHazard && (
                          <span className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 font-bold border border-rose-200 flex items-center gap-1 whitespace-nowrap" title={`Tiền độc hại: ${emp.customAllowances.hazardousAllowance.toLocaleString()} VNĐ`}>
                            <Biohazard className="w-3 h-3 text-rose-600" />
                            Độc hại
                          </span>
                        )}
                        {emp.customAllowances?.extraBonus && emp.customAllowances.extraBonus > 0 && (
                          <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 font-bold border border-emerald-200 flex items-center gap-1 whitespace-nowrap" title={`Thưởng thêm: ${emp.customAllowances.extraBonus.toLocaleString()} VNĐ`}>
                            <Gift className="w-3 h-3 text-emerald-600" />
                            +{(emp.customAllowances.extraBonus / 1000).toLocaleString()}k
                          </span>
                        )}
                        {!isPCCC && !isHazard && (!emp.customAllowances?.extraBonus || emp.customAllowances.extraBonus <= 0) && (
                          <span className="text-slate-400 font-normal">Tiêu chuẩn</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-center whitespace-nowrap min-w-[130px]">
                      <span className={`px-2.5 py-1 rounded-full font-bold whitespace-nowrap inline-block ${
                        (emp.annualLeaveBalance?.remainingDays ?? 12) <= 2
                          ? 'bg-rose-100 text-rose-700'
                          : 'bg-emerald-100 text-emerald-800'
                      }`}>
                        {emp.annualLeaveBalance?.remainingDays ?? 12} / {emp.annualLeaveBalance?.initialQuota ?? 12} ngày
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center whitespace-nowrap min-w-[130px]">
                      {emp.status === 'ACTIVE' && (
                        emp.businessTripStartDate && emp.businessTripEndDate ? (
                          <div className="flex flex-col items-center gap-0.5">
                            <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-bold border border-blue-200 whitespace-nowrap inline-block">
                              Đi công tác
                            </span>
                            <div className="text-[10px] text-blue-700 font-medium whitespace-nowrap">
                              {emp.businessTripStartDate} → {emp.businessTripEndDate}
                            </div>
                            {emp.businessTripLocation && (
                              <div className="text-[9px] text-slate-500 italic max-w-[120px] truncate" title={emp.businessTripLocation}>
                                ({emp.businessTripLocation})
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-semibold whitespace-nowrap inline-block">Đang làm việc</span>
                        )
                      )}
                      {emp.status === 'MATERNITY' && (
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 font-bold border border-purple-200 whitespace-nowrap inline-block">
                            Nghỉ thai sản
                          </span>
                          {(emp.maternityStartDate || emp.maternityEndDate) && (
                            <div className="text-[10px] text-purple-700 font-medium whitespace-nowrap">
                              {emp.maternityStartDate} → {emp.maternityEndDate}
                            </div>
                          )}
                        </div>
                      )}
                      {emp.status === 'RESIGNED' && (
                        <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-semibold whitespace-nowrap inline-block">Đã nghỉ việc</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap min-w-[110px]">
                      <div className="flex items-center justify-end gap-1">
                        {hasPermission('MANAGE_EMPLOYEES') && emp.status !== 'RESIGNED' && (
                          <button
                            onClick={() => handleOpenSpecialModal(emp)}
                            className="p-1.5 text-slate-500 hover:text-purple-600 hover:bg-purple-50 rounded-lg transition"
                            title="Cấu hình Chế độ Thai sản & Đi công tác"
                          >
                            <Plane className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {hasPermission('MANAGE_EMPLOYEES') && (
                          <button
                            onClick={() => handleOpenAddEditModal(emp)}
                            className="p-1.5 text-slate-500 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition"
                            title="Chỉnh sửa thông tin & phụ cấp"
                          >
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {hasPermission('MANAGE_EMPLOYEES') && (
                          <button
                            onClick={() => handleDeleteEmployee(emp)}
                            className="p-1.5 text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition"
                            title={emp.status === 'RESIGNED' ? 'Xóa vĩnh viễn khỏi hệ thống' : 'Xóa nhân viên (Chuyển sang Đã nghỉ việc, tính KPI nghỉ việc & tự xóa khi bắt đầu tháng mới)'}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / Edit Employee Modal */}
      {editingEmployee && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl border border-slate-100 max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-bold text-slate-900 pb-3 border-b border-slate-100">
              {rawEmployees.some(e => e.employeeId === editingEmployee.employeeId) ? 'Chỉnh Sửa Nhân Viên & Phụ Cấp' : 'Thêm Nhân Viên Mới'}
            </h3>

            <form onSubmit={handleSaveEmployee} className="mt-4 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Mã Nhân Viên (LEPxxx) *</label>
                  <input
                    type="text"
                    value={editingEmployee.employeeId}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, employeeId: e.target.value })}
                    required
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-orange-500"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Mã Chấm Công / ERP ID</label>
                  <input
                    type="text"
                    value={editingEmployee.erpId || ''}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, erpId: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-orange-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Họ và Tên *</label>
                  <input
                    type="text"
                    value={editingEmployee.fullName}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, fullName: e.target.value })}
                    required
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-orange-500"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Phòng Ban (Department)</label>
                  {showAddDept ? (
                    <div className="flex gap-1">
                      <input
                        type="text"
                        value={newDeptName}
                        onChange={(e) => setNewDeptName(e.target.value)}
                        placeholder="Tên phòng ban mới"
                        className="flex-1 px-3 py-2 bg-white border border-orange-300 rounded-xl focus:outline-none focus:border-orange-500"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const trimmed = newDeptName.trim();
                          if (trimmed) {
                            setEditingEmployee({ ...editingEmployee, department: trimmed });
                            setShowAddDept(false);
                            setNewDeptName('');
                            success('Đã thêm phòng ban', `"${trimmed}" sẽ xuất hiện trong danh sách và đồng bộ toàn hệ thống.`);
                          }
                        }}
                        className="px-3 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-xs font-bold"
                      >
                        Lưu
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowAddDept(false); setNewDeptName(''); }}
                        className="px-2.5 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl"
                      >
                        Hủy
                      </button>
                    </div>
                  ) : (
                    (() => {
                      const deptOptions = Array.from(new Set([
                        ...(['Finance','EHS','Logistics','WH','Production','QC','Maintenance (PRO)','Purchasing','Admin','HR'] as const),
                        ...rawEmployees.map(e => e.department).filter(Boolean) as string[],
                        ...(editingEmployee.department && !(['Finance','EHS','Logistics','WH','Production','QC','Maintenance (PRO)','Purchasing','Admin','HR'].includes(editingEmployee.department) || rawEmployees.some(e => e.department === editingEmployee.department)) ? [] : editingEmployee.department ? [editingEmployee.department] : [])
                      ]));
                      const uniqueDepts = Array.from(new Set(deptOptions)).sort();
                      return (
                        <div className="flex gap-1">
                          <select
                            value={editingEmployee.department}
                            onChange={(e) => setEditingEmployee({ ...editingEmployee, department: e.target.value })}
                            className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-orange-500"
                          >
                            <option value="">-- Chọn phòng ban --</option>
                            {uniqueDepts.map(d => (
                              <option key={d} value={d}>{d}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => setShowAddDept(true)}
                            className="px-2.5 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-xl flex items-center justify-center shrink-0"
                            title="Thêm phòng ban mới"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                        </div>
                      );
                    })()
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Chức Vụ (Position)</label>
                  {showAddPos ? (
                    <div className="flex gap-1">
                      <input
                        type="text"
                        value={newPosName}
                        onChange={(e) => setNewPosName(e.target.value)}
                        placeholder="Tên chức vụ mới"
                        className="flex-1 px-3 py-2 bg-white border border-orange-300 rounded-xl focus:outline-none focus:border-orange-500"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const trimmed = newPosName.trim();
                          if (trimmed) {
                            setEditingEmployee({ ...editingEmployee, position: trimmed });
                            setShowAddPos(false);
                            setNewPosName('');
                            success('Đã thêm chức vụ', `"${trimmed}" sẽ xuất hiện trong danh sách và đồng bộ toàn hệ thống.`);
                          }
                        }}
                        className="px-3 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-xs font-bold"
                      >
                        Lưu
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowAddPos(false); setNewPosName(''); }}
                        className="px-2.5 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-xl"
                      >
                        Hủy
                      </button>
                    </div>
                  ) : (
                    (() => {
                      const posOptions = Array.from(new Set(rawEmployees.map(e => e.position).filter(Boolean) as string[])).sort();
                      const allPos = editingEmployee.position && !posOptions.includes(editingEmployee.position) ? [...posOptions, editingEmployee.position] : posOptions;
                      return (
                        <div className="flex gap-1">
                          <select
                            value={editingEmployee.position}
                            onChange={(e) => setEditingEmployee({ ...editingEmployee, position: e.target.value })}
                            className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-orange-500"
                          >
                            <option value="">-- Chọn chức vụ --</option>
                            {allPos.map(p => (
                              <option key={p} value={p}>{p}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => setShowAddPos(true)}
                            className="px-2.5 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-xl flex items-center justify-center shrink-0"
                            title="Thêm chức vụ mới"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                        </div>
                      );
                    })()
                  )}
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Ngày Bắt Đầu Làm Việc</label>
                  <input
                    type="text"
                    value={editingEmployee.startDate}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, startDate: e.target.value })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-orange-500"
                  />
                </div>
              </div>

              {/* Shift Class & Contract Type */}
              <div className="grid grid-cols-2 gap-4 pt-2 border-t border-slate-100">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Nhóm Ca Quy Định</label>
                  <select
                    value={editingEmployee.shiftClassId}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, shiftClassId: e.target.value as ShiftClassType })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl"
                  >
                    <option value="OFFICE_M_F">Hành chính VP (Thứ 2 - Thứ 6 | 23 công chuẩn)</option>
                    <option value="OFFICE_M_S">Hành chính chung (Thứ 2 - Thứ 7 | 27 công chuẩn)</option>
                    <option value="SHIFT_1">Ca 1 (06:00 - 14:00 xoay ca)</option>
                    <option value="SHIFT_2">Ca 2 (14:00 - 22:00 xoay ca)</option>
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Hợp Đồng & Chu Kỳ Công</label>
                  <select
                    value={editingEmployee.contractType}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, contractType: e.target.value as ContractType })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl"
                  >
                    <option value="OFFICIAL">Chính thức (Chu kỳ 21 tháng trước - 20 tháng này)</option>
                    <option value="SEASONAL">Thời vụ (Chu kỳ 1 - 31 hàng tháng)</option>
                  </select>
                </div>
              </div>

              {/* Production Line & Productivity Group */}
              <div className="grid grid-cols-2 gap-4 pt-2 border-t border-slate-100">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Chuyền / Line Sản Xuất</label>
                  <select
                    value={editingEmployee.productionLine || ''}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, productionLine: e.target.value || undefined })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl"
                  >
                    <option value="">-- Không thuộc Line --</option>
                    {rawProductionLines.map(l => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Nhóm Năng Suất</label>
                  <select
                    value={editingEmployee.productivityGroup || ''}
                    onChange={(e) => setEditingEmployee({
                      ...editingEmployee,
                      productivityGroup: e.target.value ? (parseInt(e.target.value) as 1 | 2) : undefined
                    })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl"
                  >
                    <option value="">-- Không phân nhóm --</option>
                    <option value="1">Nhóm 1 (Hưởng theo % Đạt Line)</option>
                    <option value="2">Nhóm 2 (Đơn giá 1.000.000đ × công thực tế / chuẩn)</option>
                  </select>
                </div>
              </div>

              {/* Trạng Thái & Nghỉ Thai Sản */}
              <div className="grid grid-cols-2 gap-4 pt-2 border-t border-slate-100">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Trạng Thái Làm Việc</label>
                  <select
                    value={editingEmployee.status}
                    onChange={(e) => setEditingEmployee({ ...editingEmployee, status: e.target.value as any })}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl"
                  >
                    <option value="ACTIVE">Đang làm việc (ACTIVE)</option>
                    <option value="MATERNITY">Nghỉ thai sản (MATERNITY)</option>
                    <option value="RESIGNED">Đã nghỉ việc (RESIGNED)</option>
                  </select>
                </div>
                {editingEmployee.status === 'MATERNITY' && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block font-bold text-slate-700 mb-1">Bắt đầu thai sản</label>
                      <input
                        type="date"
                        value={editingEmployee.maternityStartDate || ''}
                        onChange={(e) => setEditingEmployee({ ...editingEmployee, maternityStartDate: e.target.value })}
                        className="w-full px-2 py-1.5 bg-slate-50 border border-purple-300 rounded-xl text-xs"
                      />
                    </div>
                    <div>
                      <label className="block font-bold text-slate-700 mb-1">Kết thúc thai sản</label>
                      <input
                        type="date"
                        value={editingEmployee.maternityEndDate || ''}
                        onChange={(e) => setEditingEmployee({ ...editingEmployee, maternityEndDate: e.target.value })}
                        className="w-full px-2 py-1.5 bg-slate-50 border border-purple-300 rounded-xl text-xs"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Hợp đồng & Thử việc */}
              <div className="p-4 bg-amber-50/40 rounded-xl border border-amber-200/60 space-y-3">
                <div className="font-bold text-slate-900 text-xs flex items-center gap-1.5">
                  <Calendar className="w-4 h-4 text-amber-600" />
                  <span>Hợp Đồng & Thời Gian Thử Việc</span>
                  <span className="ml-auto text-[10px] font-normal text-slate-500">Thử việc 1-2 tháng: không tính tăng ca & phép năm đến khi hết thử việc</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Thời hạn hợp đồng</label>
                    <select
                      value={editingEmployee.contractTerm || ''}
                      onChange={(e) => {
                        const term = e.target.value as any;
                        let endDate = editingEmployee.contractEndDate;
                        // Tự tính ngày kết thúc nếu có ngày bắt đầu
                        if (term && editingEmployee.contractStartDate) {
                          const s = editingEmployee.contractStartDate;
                          const parse = (str:string) => {
                            if (str.includes('/')) { const [d,m,y]=str.split('/').map(Number); return new Date(y,m-1,d); }
                            if (str.includes('-')) { const [y,m,d]=str.split('-').map(Number); return new Date(y,m-1,d); }
                            return null;
                          };
                          const sd = parse(s);
                          if (sd) {
                            const ed = new Date(sd);
                            if (term === '1_MONTH') ed.setMonth(ed.getMonth()+1);
                            else if (term === '2_MONTHS') ed.setMonth(ed.getMonth()+2);
                            else if (term === '1_YEAR') ed.setFullYear(ed.getFullYear()+1);
                            else if (term === '3_YEARS') ed.setFullYear(ed.getFullYear()+3);
                            else if (term === 'PERMANENT') endDate = '';
                            if (term !== 'PERMANENT') endDate = `${String(ed.getDate()).padStart(2,'0')}/${String(ed.getMonth()+1).padStart(2,'0')}/${ed.getFullYear()}`;
                          }
                        }
                        setEditingEmployee({ ...editingEmployee, contractTerm: term || undefined, contractEndDate: endDate });
                      }}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl"
                    >
                      <option value="">-- Chưa cấu hình --</option>
                      <option value="1_MONTH">1 tháng</option>
                      <option value="2_MONTHS">2 tháng</option>
                      <option value="1_YEAR">1 năm</option>
                      <option value="3_YEARS">3 năm</option>
                      <option value="PERMANENT">Vĩnh viễn</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Thời gian thử việc</label>
                    <select
                      value={editingEmployee.probationMonths || ''}
                      onChange={(e) => {
                        const v = e.target.value ? parseInt(e.target.value) as 1|2 : undefined;
                        let probEnd = editingEmployee.probationEndDate;
                        if (v && editingEmployee.startDate) {
                          const s = editingEmployee.startDate;
                          const parse = (str:string) => {
                            if (str.includes('/')) { const [d,m,y]=str.split('/').map(Number); return new Date(y,m-1,d); }
                            if (str.includes('-')) { const [y,m,d]=str.split('-').map(Number); return new Date(y,m-1,d); }
                            return null;
                          };
                          const sd = parse(s);
                          if (sd) {
                            const ed = new Date(sd);
                            ed.setMonth(ed.getMonth()+v);
                            probEnd = `${String(ed.getDate()).padStart(2,'0')}/${String(ed.getMonth()+1).padStart(2,'0')}/${ed.getFullYear()}`;
                          }
                        } else if (!v) probEnd = undefined;
                        setEditingEmployee({ ...editingEmployee, probationMonths: v, probationEndDate: probEnd });
                      }}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl"
                    >
                      <option value="">Không thử việc</option>
                      <option value="1">1 tháng</option>
                      <option value="2">2 tháng</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Ngày bắt đầu HĐ</label>
                    <input type="text" placeholder="DD/MM/YYYY" value={editingEmployee.contractStartDate || ''} onChange={e => setEditingEmployee({ ...editingEmployee, contractStartDate: e.target.value })} className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl" />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Ngày kết thúc HĐ</label>
                    <input type="text" placeholder="DD/MM/YYYY" value={editingEmployee.contractEndDate || ''} onChange={e => setEditingEmployee({ ...editingEmployee, contractEndDate: e.target.value })} className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl" />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Kết thúc thử việc</label>
                    <input type="text" placeholder="DD/MM/YYYY" value={editingEmployee.probationEndDate || ''} onChange={e => setEditingEmployee({ ...editingEmployee, probationEndDate: e.target.value })} className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-amber-700 font-semibold" />
                  </div>
                </div>
              </div>

              {/* Custom Allowances Section */}
              <div className="p-4 bg-orange-50/40 rounded-xl border border-orange-200/60 space-y-3">
                <div className="font-bold text-slate-900 text-xs flex items-center gap-1.5 text-orange-950">
                  <SlidersHorizontal className="w-4 h-4 text-orange-600" />
                  <span>Phân Bổ Phụ Cấp Linh Hoạt Từng Cá Nhân (Custom Allowances)</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Trợ cấp PCCC (VNĐ)</label>
                    <input
                      type="number"
                      value={editingEmployee.customAllowances?.pcccAllowance || 0}
                      onChange={(e) => setEditingEmployee({
                        ...editingEmployee,
                        customAllowances: {
                          ...editingEmployee.customAllowances,
                          pcccAllowance: parseFloat(e.target.value) || 0
                        }
                      })}
                      className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Tiền Độc Hại (VNĐ)</label>
                    <input
                      type="number"
                      value={editingEmployee.customAllowances?.hazardousAllowance || 0}
                      onChange={(e) => setEditingEmployee({
                        ...editingEmployee,
                        customAllowances: {
                          ...editingEmployee.customAllowances,
                          hazardousAllowance: parseFloat(e.target.value) || 0
                        }
                      })}
                      className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Tiền Chuyên Cần (VNĐ)</label>
                    <input
                      type="number"
                      value={editingEmployee.customAllowances?.diligenceBonus || 500000}
                      onChange={(e) => setEditingEmployee({
                        ...editingEmployee,
                        customAllowances: {
                          ...editingEmployee.customAllowances,
                          diligenceBonus: parseFloat(e.target.value) || 0
                        }
                      })}
                      className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">Thưởng Thêm (VNĐ)</label>
                    <input
                      type="number"
                      value={editingEmployee.customAllowances?.extraBonus || 0}
                      onChange={(e) => setEditingEmployee({
                        ...editingEmployee,
                        customAllowances: {
                          ...editingEmployee.customAllowances,
                          extraBonus: parseFloat(e.target.value) || 0
                        }
                      })}
                      className="w-full px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs"
                    />
                  </div>
                </div>
              </div>

              {/* Annual Leave Quota */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Hạn Mức Phép Năm Ban Đầu (Ngày)</label>
                  <input
                    type="number"
                    min={0}
                    value={editingEmployee.annualLeaveBalance?.initialQuota ?? 12}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const init = raw === '' ? 0 : parseFloat(raw) || 0;
                      const used = editingEmployee.annualLeaveBalance?.usedDays ?? 0;
                      setEditingEmployee({
                        ...editingEmployee,
                        annualLeaveBalance: {
                          initialQuota: init,
                          usedDays: used,
                          remainingDays: Math.max(0, init - used)
                        }
                      });
                    }}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">Số Phép Năm Còn Lại (Ngày)</label>
                  <input
                    type="number"
                    min={0}
                    value={editingEmployee.annualLeaveBalance?.remainingDays ?? 12}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const val = raw === '' ? 0 : parseFloat(raw);
                      const num = isNaN(val) ? 0 : val;
                      setEditingEmployee({
                        ...editingEmployee,
                        annualLeaveBalance: {
                          ...editingEmployee.annualLeaveBalance!,
                          remainingDays: num
                        }
                      });
                    }}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-bold text-blue-600"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditingEmployee(null)}
                  className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl transition"
                >
                  Hủy bỏ
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-gradient-to-r from-orange-500 to-rose-500 text-white font-bold rounded-xl shadow-md transition"
                >
                  Lưu Thông Tin
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Unified Special Regimes Modal (Thai sản & Đi công tác) */}
      {specialModalEmp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-100 space-y-4">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Plane className="w-5 h-5 text-purple-600" />
                <span>Cấu Hình Chế Độ Đặc Biệt (Thai Sản & Đi Công Tác)</span>
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                Nhân viên: <b className="text-slate-700">{specialModalEmp.fullName}</b> ({specialModalEmp.employeeId}) • Bộ phận: <b className="text-slate-700">{specialModalEmp.department}</b>
              </p>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-200">
              <button
                type="button"
                onClick={() => setSpecialTab('MATERNITY')}
                className={`pb-2.5 px-4 text-xs font-bold transition border-b-2 flex items-center gap-1.5 ${
                  specialTab === 'MATERNITY'
                    ? 'border-purple-600 text-purple-700'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                <span>Nghỉ Thai Sản (ML)</span>
                {maternityActive && (
                  <span className="w-2 h-2 rounded-full bg-purple-600"></span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setSpecialTab('BUSINESS_TRIP')}
                className={`pb-2.5 px-4 text-xs font-bold transition border-b-2 flex items-center gap-1.5 ${
                  specialTab === 'BUSINESS_TRIP'
                    ? 'border-blue-600 text-blue-700'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                <span>Đi Công Tác (BT)</span>
                {tripActive && (
                  <span className="w-2 h-2 rounded-full bg-blue-600"></span>
                )}
              </button>
            </div>

            <form onSubmit={handleSaveSpecialModal} className="space-y-4 text-xs">
              {specialTab === 'MATERNITY' && (
                <div className="space-y-3 animate-in fade-in duration-150">
                  <div className="p-3 bg-purple-50/70 rounded-xl border border-purple-200/80 space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer font-bold text-purple-950">
                      <input
                        type="checkbox"
                        checked={maternityActive}
                        onChange={(e) => setMaternityActive(e.target.checked)}
                        className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500 border-slate-300"
                      />
                      <span>Kích hoạt chế độ Nghỉ thai sản (Maternity Leave - ML)</span>
                    </label>
                    <p className="text-[11px] text-purple-800 leading-relaxed">
                      Khi bật chế độ này, mọi ngày làm việc trong khoảng thời gian cấu hình khi import file chấm công sẽ <b>tự động điền mã "ML"</b> và trạng thái nhân viên hiển thị <b>"Nghỉ thai sản"</b>.
                    </p>
                  </div>

                  {maternityActive && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                      <div>
                        <label className="block font-bold text-slate-700 mb-1">Ngày bắt đầu thai sản *</label>
                        <input
                          type="date"
                          value={maternityStart}
                          onChange={(e) => {
                            const start = e.target.value;
                            setMaternityStart(start);
                            if (start) {
                              try {
                                const d = new Date(start);
                                d.setMonth(d.getMonth() + 6);
                                setMaternityEnd(d.toISOString().slice(0, 10));
                              } catch {}
                            }
                          }}
                          required={maternityActive}
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-purple-500"
                        />
                      </div>
                      <div>
                        <label className="block font-bold text-slate-700 mb-1">Ngày kết thúc (Gợi ý 6 tháng) *</label>
                        <input
                          type="date"
                          value={maternityEnd}
                          onChange={(e) => setMaternityEnd(e.target.value)}
                          required={maternityActive}
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-purple-500"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {specialTab === 'BUSINESS_TRIP' && (
                <div className="space-y-3 animate-in fade-in duration-150">
                  <div className="p-3 bg-blue-50/70 rounded-xl border border-blue-200/80 space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer font-bold text-blue-950">
                      <input
                        type="checkbox"
                        checked={tripActive}
                        onChange={(e) => setTripActive(e.target.checked)}
                        className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 border-slate-300"
                      />
                      <span>Kích hoạt chế độ Đi công tác (Business Trip - BT)</span>
                    </label>
                    <p className="text-[11px] text-blue-800 leading-relaxed">
                      Khi bật chế độ này, mọi ngày trong khoảng thời gian đi công tác khi import file chấm công sẽ <b>tự động điền mã "BT"</b> và không tính là vắng hay đi trễ.
                    </p>
                  </div>

                  {tripActive && (
                    <div className="space-y-3 pt-1">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block font-bold text-slate-700 mb-1">Ngày bắt đầu công tác *</label>
                          <input
                            type="date"
                            value={tripStart}
                            onChange={(e) => setTripStart(e.target.value)}
                            required={tripActive}
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block font-bold text-slate-700 mb-1">Ngày kết thúc công tác *</label>
                          <input
                            type="date"
                            value={tripEnd}
                            onChange={(e) => setTripEnd(e.target.value)}
                            required={tripActive}
                            className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block font-bold text-slate-700 mb-1">Địa điểm / Lý do công tác</label>
                        <input
                          type="text"
                          value={tripLocation}
                          onChange={(e) => setTripLocation(e.target.value)}
                          placeholder="Ví dụ: Công tác chi nhánh Đà Nẵng, Nhà máy Hải Phòng..."
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-blue-500"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setSpecialModalEmp(null)}
                  className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl transition"
                >
                  Hủy bỏ
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-bold rounded-xl shadow-md transition"
                >
                  Lưu Cấu Hình
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
