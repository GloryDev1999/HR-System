/**
 * import-diff — so sánh dữ liệu file nguồn với dữ liệu hệ thống trước khi ghi (KB-028).
 *
 * Nguyên tắc incremental (không xóa toàn bảng nữa):
 * - Ô công / Tăng ca: so theo PK employeeId_date → thêm mới / thay đổi / khớp (bỏ qua).
 * - Quẹt thẻ thô: append-only, dedupe theo khóa tự nhiên (NV + ngày + vào + ra).
 * - Yêu cầu phép: dedupe theo khóa tự nhiên; id UUID do DB sinh (bỏ id LEAVE_* cũ
 *   vì cột leave_requests.id là UUID — ghi string lạ sẽ lỗi DB).
 * - Tăng ca đã đối soát (MATCHED/MISMATCH) được BẢO TỒN, không ghi đè bởi tính lại.
 */

export interface TsConflict {
  key: string;
  employeeId: string;
  date: string;
  field: string;
  oldVal: string;
  newVal: string;
}

export interface TsChange {
  record: any;
  conflicts: TsConflict[];
}

export interface ImportDiff {
  tsAdded: any[];
  tsChanged: TsChange[];
  otAdded: any[];
  otChanged: any[];
  otPreserved: number; // bản ghi OT đã đối soát được giữ nguyên
  logsAdded: any[];
  leavesAdded: any[];
}

const TS_COMPARE_FIELDS = ['checkIn', 'checkOut', 'statusCode', 'lateMinutes', 'earlyMinutes'] as const;
const OT_COMPARE_FIELDS = ['hours', 'verificationStatus', 'note', 'startTime', 'endTime', 'rawMinutes'] as const;

const str = (v: any): string => (v === null || v === undefined ? '' : String(v));

export function diffTimesheets(existing: any[], incoming: any[]): { added: any[]; changed: TsChange[] } {
  const oldMap = new Map<string, any>(existing.map(r => [r.employeeId_date, r]));
  const added: any[] = [];
  const changed: TsChange[] = [];
  const seen = new Set<string>();
  for (const rec of incoming) {
    const key = rec.employeeId_date;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const old = oldMap.get(key);
    if (!old) {
      added.push(rec);
      continue;
    }
    const conflicts: TsConflict[] = [];
    for (const f of TS_COMPARE_FIELDS) {
      if (str((old as any)[f]) !== str((rec as any)[f])) {
        conflicts.push({ key, employeeId: rec.employeeId, date: rec.date, field: f, oldVal: str((old as any)[f]), newVal: str((rec as any)[f]) });
      }
    }
    if (conflicts.length > 0) changed.push({ record: rec, conflicts });
  }
  return { added, changed };
}

export function diffOvertimes(
  existing: any[],
  incoming: any[]
): { added: any[]; changed: TsChange[]; preserved: number } {
  const oldMap = new Map<string, any>(existing.map(r => [r.employeeId_date, r]));
  const added: any[] = [];
  const changed: TsChange[] = [];
  let preserved = 0;
  const seen = new Set<string>();
  for (const rec of incoming) {
    const key = rec.employeeId_date;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const old = oldMap.get(key);
    if (!old) {
      added.push(rec);
      continue;
    }
    // Đã đối soát (MATCHED/MISMATCH): giữ nguyên, không ghi đè
    if (old.verificationStatus && old.verificationStatus !== 'PENDING') {
      preserved++;
      continue;
    }
    const conflicts: TsConflict[] = [];
    for (const f of OT_COMPARE_FIELDS) {
      if (str((old as any)[f]) !== str((rec as any)[f])) {
        conflicts.push({ key, employeeId: rec.employeeId, date: rec.date, field: f, oldVal: str((old as any)[f]), newVal: str((rec as any)[f]) });
      }
    }
    if (conflicts.length > 0) changed.push({ record: rec, conflicts });
  }
  return { added, changed, preserved };
}

const logKey = (r: any): string =>
  `${r.employeeId}_${r.date}_${str(r.checkIn)}_${str(r.checkOut)}`;

/** Quẹt thẻ thô: chỉ thêm mới (không update, không xóa). */
export function diffRawLogs(existing: any[], incoming: any[]): any[] {
  const oldKeys = new Set(existing.map(logKey));
  const seen = new Set<string>();
  const added: any[] = [];
  for (const rec of incoming) {
    const k = logKey(rec);
    if (oldKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    added.push(rec);
  }
  return added;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bỏ id không phải UUID để DB tự sinh (cột leave_requests.id là UUID). */
export function sanitizeLeaveForDb<T extends Record<string, any>>(l: T): T {
  if (l && typeof l.id === 'string' && !UUID_RE.test(l.id)) {
    const { id: _drop, ...rest } = l;
    return rest as T;
  }
  return l;
}

const leaveKey = (r: any): string =>
  `${r.employeeId}_${r.date}_${str(r.leaveType)}_${str(r.missedHours)}_${str(r.status)}`;

/** Yêu cầu phép: dedupe theo khóa tự nhiên (NV + ngày + loại + giờ + trạng thái). */
export function diffLeaves(existing: any[], incoming: any[]): any[] {
  const oldKeys = new Set(existing.map(leaveKey));
  const seen = new Set<string>();
  const added: any[] = [];
  for (const rec of incoming) {
    const clean = sanitizeLeaveForDb(rec);
    const k = leaveKey(clean);
    if (oldKeys.has(k) || seen.has(k)) continue;
    seen.add(k);
    added.push(clean);
  }
  return added;
}
