/**
 * JSON Sync Service — Đồng bộ thuần JSON qua 1 thư mục OneDrive (thay thế Star-Topology RTC).
 *
 * Phương án A (Dual-master merge theo record) đã được user chốt:
 * - kieu (AD System) = Master Owner, hoa (HR Manager) = Co-Owner. Mỗi người 1 file master riêng,
 *   không bao giờ ghi đè lên file của nhau: master_kieu.json / master_hoa.json
 * - vinh / nguyetanh / han = Dept Admin (KHÔNG phải manager, giữ nguyên RBAC):
 *   mỗi user 1 file dept riêng: dept_WH_vinh.json / dept_QC_nguyetanh.json / dept_PRD_han.json
 * - Merge theo từng PK với Last-Writer-Wins + tie-break kieu > hoa, kèm audit ai sửa.
 * - Employees: KHÔNG bao giờ xóa khi merge (chỉ đổi status), chặn trùng erpId.
 * - productivityQualityRates: merge theo từng field NS/CL riêng để han (NS) và nguyetanh (CL)
 *   sửa cùng record không mất dữ liệu của nhau.
 * - userAuditLogs + shift_submissions: union append-only theo id.
 * - Cấp quyền ổ đĩa 1 lần: lưu DirectoryHandle vào IndexedDB, các lần sau chỉ 1 click
 *   "Kết nối thư mục", fallback tải file thủ công khi trình duyệt không hỗ trợ.
 */

import { db } from '../db';
import { logUserAction } from './audit-log-service';

export const JSON_SYNC_SCHEMA_VERSION = '4.0.0';
export const JSON_SYNC_DIR_DB = 'smarthr_json_sync_db';
export const JSON_SYNC_DIR_STORE = 'handles';
export const JSON_SYNC_DIR_KEY = 'hr_data_dir';
export const JSON_SYNC_STATE_KEY = 'json_sync_state';

export type SyncUsername = string; // 'kieu' | 'hoa' | 'vinh' | 'nguyetanh' | 'han' | 'glory' | ...
export type DeptScope = 'WH' | 'QC' | 'Production';

export const DEPT_SCOPE_BY_USER: Record<string, DeptScope> = {
  vinh: 'WH',
  nguyetanh: 'QC',
  han: 'Production',
};

export const DEPT_FILE_BY_USER: Record<string, string> = {
  vinh: 'dept_WH_vinh.json',
  nguyetanh: 'dept_QC_nguyetanh.json',
  han: 'dept_PRD_han.json',
};

export const MASTER_FILE_BY_USER: Record<string, string> = {
  kieu: 'master_kieu.json',
  hoa: 'master_hoa.json',
  glory: 'master_glory.json',
};

export const KNOWN_SYNC_FILES = [
  'master_kieu.json',
  'master_hoa.json',
  'master_glory.json',
  'dept_WH_vinh.json',
  'dept_QC_nguyetanh.json',
  'dept_PRD_han.json',
];

/** Metadata truy vết ai sửa, gắn kèm mỗi record khi export/save (không cần index Dexie). */
export interface SyncMeta {
  at: string; // ISO
  by: string; // username
}

export interface RateFieldMeta extends SyncMeta {
  field: 'NS' | 'CL';
}

function nowIso(): string {
  return new Date().toISOString();
}

function toMs(isoLike: unknown, fallbackMs: number): number {
  if (typeof isoLike === 'string') {
    const t = Date.parse(isoLike);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof isoLike === 'number' && Number.isFinite(isoLike)) return isoLike;
  return fallbackMs;
}

/** Gắn _sync {at, by} lên record (dùng cho mọi bảng có thể merge). */
export function stampSyncMeta<T extends object>(rec: T, username: string, at = nowIso()): T {
  (rec as any)._sync = { at, by: username.toLowerCase() } as SyncMeta;
  return rec;
}

/** Gắn meta theo field NS/CL cho productivity rates (han sửa NS, nguyetanh sửa CL). */
export function stampRateFieldMeta(
  rate: Record<string, any>,
  field: 'NS' | 'CL',
  username: string,
  at = nowIso()
): void {
  const key = field === 'NS' ? '_syncNS' : '_syncCL';
  rate[key] = { at, by: username.toLowerCase(), field } as RateFieldMeta;
  // Đồng thời cập nhật _sync chung = field mới nhất để sort/scan dễ
  const otherKey = field === 'NS' ? '_syncCL' : '_syncNS';
  const cur = rate._sync as SyncMeta | undefined;
  const mine = rate[key] as SyncMeta;
  const other = rate[otherKey] as SyncMeta | undefined;
  if (!cur || toMs(mine.at, 0) >= toMs(cur.at, 0)) rate._sync = { ...mine };
  else if (other && toMs(other.at, 0) > toMs((rate._sync as any)?.at, 0)) rate._sync = { ...other };
  if (!rate.updatedAt) rate.updatedAt = at;
  if (!rate.updatedBy) rate.updatedBy = username.toLowerCase();
}

const RECORD_DATE_KEYS = [
  'updatedAt',
  'processedAt',
  'verifiedAt',
  'submittedAt',
  'lastLoginAt',
  'scanTimestamp',
  'timestamp',
  'createdAt',
] as const;

const RECORD_AUTHOR_KEYS = [
  'updatedBy',
  'processedBy',
  'verifiedBy',
  'senderUsername',
  'username',
] as const;

/** Mốc thời gian của 1 record để LWW (ưu tiên _sync.at, rồi các date field, rồi file exportedAt). */
export function getRecordStamp(rec: Record<string, any>, fallbackExportedAt: string): number {
  const fallback = toMs(fallbackExportedAt, 0);
  const sync = rec?._sync as SyncMeta | undefined;
  if (sync?.at) {
    const t = Date.parse(sync.at);
    if (!Number.isNaN(t)) return t;
  }
  for (const k of RECORD_DATE_KEYS) {
    const v = rec?.[k];
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return fallback;
}

/** Tác giả của 1 record để hiển thị "ai thay đổi". */
export function getRecordAuthor(rec: Record<string, any>, fallbackBy: string): string {
  const sync = rec?._sync as SyncMeta | undefined;
  if (sync?.by) return String(sync.by).toLowerCase();
  for (const k of RECORD_AUTHOR_KEYS) {
    const v = rec?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase();
  }
  return (fallbackBy || 'unknown').toLowerCase();
}

export interface ConflictEntry {
  table: string;
  pk: string;
  localAt: string;
  localBy: string;
  incomingAt: string;
  incomingBy: string;
  winner: 'local' | 'incoming';
  reason: string;
}

/** Ưu tiên tie-break khi cùng mốc thời gian: kieu > hoa > glory > còn lại (so theo incoming thắng hay không). */
export function tieBreakWinner(incomingBy: string, localBy: string): 'local' | 'incoming' {
  const rank = (u: string): number => {
    const v = (u || '').toLowerCase();
    if (v === 'kieu') return 0;
    if (v === 'hoa') return 1;
    if (v === 'glory') return 2;
    return 3;
  };
  // Rank nhỏ hơn = quyền cao hơn. Hòa rank thì incoming (dữ liệu mới quét) thắng để không kẹt.
  return rank(incomingBy) <= rank(localBy) ? 'incoming' : 'local';
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => k !== '_sync' && k !== '_syncNS' && k !== '_syncCL').sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function isSameRecordData(a: Record<string, any>, b: Record<string, any>): boolean {
  return stableStringify(a) === stableStringify(b);
}

export interface TableMergeResult<T> {
  toPut: T[];
  applied: number;
  skipped: number;
  conflicts: ConflictEntry[];
}

/**
 * Merge LWW cho 1 bảng theo PK (pure, không đụng Dexie — dùng được trong test).
 * - incoming mới hơn local -> apply
 * - cũ hơn -> skip
 * - bằng mốc giờ nhưng khác dữ liệu -> tie-break kieu>hoa, ghi conflict
 */
export function mergeTableRecords<T extends Record<string, any>>(
  table: string,
  local: T[],
  incoming: T[],
  pkOf: (r: T) => string,
  incomingFile: { exportedAt: string; exportedBy: string },
  localFile: { exportedAt: string; exportedBy: string } = { exportedAt: '', exportedBy: '' }
): TableMergeResult<T> {
  const localMap = new Map<string, T>();
  for (const r of local) {
    const pk = pkOf(r);
    if (pk) localMap.set(pk, r);
  }
  const toPut: T[] = [];
  const conflicts: ConflictEntry[] = [];
  let applied = 0;
  let skipped = 0;

  for (const inc of incoming) {
    const pk = pkOf(inc);
    if (!pk) {
      skipped += 1;
      continue;
    }
    const cur = localMap.get(pk);
    if (!cur) {
      toPut.push(inc);
      applied += 1;
      continue;
    }
    if (isSameRecordData(cur, inc)) {
      skipped += 1;
      continue;
    }
    const incAt = getRecordStamp(inc, incomingFile.exportedAt);
    const curAt = getRecordStamp(cur, localFile.exportedAt || incomingFile.exportedAt);
    if (incAt > curAt) {
      toPut.push(inc);
      applied += 1;
    } else if (incAt < curAt) {
      skipped += 1;
    } else {
      const incBy = getRecordAuthor(inc, incomingFile.exportedBy);
      const curBy = getRecordAuthor(cur, localFile.exportedBy || incomingFile.exportedBy);
      const winner = tieBreakWinner(incBy, curBy);
      conflicts.push({
        table,
        pk,
        localAt: new Date(curAt).toISOString(),
        localBy: curBy,
        incomingAt: new Date(incAt).toISOString(),
        incomingBy: incBy,
        winner,
        reason: `Cùng mốc giờ, khác dữ liệu — ưu tiên ${winner === 'incoming' ? incBy : curBy} (kieu > hoa > glory)`,
      });
      if (winner === 'incoming') {
        toPut.push(inc);
        applied += 1;
      } else {
        skipped += 1;
      }
    }
  }
  return { toPut, applied, skipped, conflicts };
}

/**
 * Merge field-level cho productivityQualityRates:
 * - productivityRate theo stamp NS (_syncNS > updatedAt), qualityRate theo stamp CL.
 * - Hai người sửa 2 field khác nhau cùng record -> giữ cả 2, không mất.
 */
export function mergeQualityRates(
  local: Record<string, any>[],
  incoming: Record<string, any>[],
  incomingFile: { exportedAt: string; exportedBy: string }
): { toPut: Record<string, any>[]; applied: number; skipped: number; conflicts: ConflictEntry[] } {
  const localMap = new Map<string, Record<string, any>>();
  for (const r of local) if (r?.lineId_date) localMap.set(r.lineId_date, r);
  const toPut: Record<string, any>[] = [];
  const conflicts: ConflictEntry[] = [];
  let applied = 0;
  let skipped = 0;

  const fieldStamp = (r: Record<string, any>, field: 'NS' | 'CL', fb: string): number => {
    const m = (field === 'NS' ? r._syncNS : r._syncCL) as SyncMeta | undefined;
    if (m?.at) {
      const t = Date.parse(m.at);
      if (!Number.isNaN(t)) return t;
    }
    return getRecordStamp(r, fb);
  };
  const fieldBy = (r: Record<string, any>, field: 'NS' | 'CL', fb: string): string => {
    const m = (field === 'NS' ? r._syncNS : r._syncCL) as SyncMeta | undefined;
    if (m?.by) return String(m.by).toLowerCase();
    return getRecordAuthor(r, fb);
  };

  for (const inc of incoming) {
    const pk = inc?.lineId_date;
    if (!pk) {
      skipped += 1;
      continue;
    }
    const cur = localMap.get(pk);
    if (!cur) {
      toPut.push(inc);
      applied += 1;
      continue;
    }
    if (isSameRecordData(cur, inc)) {
      skipped += 1;
      continue;
    }
    const merged: Record<string, any> = { ...cur };
    let changed = false;

    (['NS', 'CL'] as const).forEach((field) => {
      const key = field === 'NS' ? 'productivityRate' : 'qualityRate';
      if (inc[key] === cur[key]) return;
      const incAt = fieldStamp(inc, field, incomingFile.exportedAt);
      const curAt = fieldStamp(cur, field, incomingFile.exportedAt);
      if (incAt > curAt) {
        merged[key] = inc[key];
        changed = true;
      } else if (incAt === curAt) {
        const w = tieBreakWinner(fieldBy(inc, field, incomingFile.exportedBy), fieldBy(cur, field, incomingFile.exportedBy));
        if (w === 'incoming') {
          merged[key] = inc[key];
          changed = true;
        }
        conflicts.push({
          table: 'productivityQualityRates',
          pk: `${pk}.${key}`,
          localAt: new Date(curAt).toISOString(),
          localBy: fieldBy(cur, field, ''),
          incomingAt: new Date(incAt).toISOString(),
          incomingBy: fieldBy(inc, field, incomingFile.exportedBy),
          winner: w,
          reason: `${key} cùng mốc giờ — giữ bản của ${w === 'incoming' ? fieldBy(inc, field, incomingFile.exportedBy) : fieldBy(cur, field, '')}`,
        });
      }
    });

    // Các field mô tả (month/year/lineId/date) lấy theo bên mới hơn chung
    const incAtAll = getRecordStamp(inc, incomingFile.exportedAt);
    const curAtAll = getRecordStamp(cur, incomingFile.exportedAt);
    if (incAtAll >= curAtAll) {
      for (const k of ['month', 'year', 'lineId', 'date', 'updatedAt', 'updatedBy', '_sync', '_syncNS', '_syncCL']) {
        if (inc[k] !== undefined) merged[k] = inc[k];
      }
      if (incAtAll > curAtAll) changed = true;
    }

    if (changed && !isSameRecordData(cur, merged)) {
      toPut.push(merged);
      applied += 1;
    } else {
      skipped += 1;
    }
  }
  return { toPut, applied, skipped, conflicts };
}

export interface EmployeeMergeResult {
  toPut: Record<string, any>[];
  applied: number;
  skipped: number;
  blocked: ConflictEntry[];
  conflicts: ConflictEntry[];
}

/**
 * Merge employees AN TOÀN:
 * - Không bao giờ xóa NV vì vắng mặt trong file incoming (tránh mất user cũ).
 * - NV mới (ID chưa có): chặn nếu trùng erpId với NV khác -> blocked, yêu cầu xử lý tay.
 * - Còn lại merge LWW như bảng thường.
 */
export function mergeEmployeesSafe(
  local: Record<string, any>[],
  incoming: Record<string, any>[],
  incomingFile: { exportedAt: string; exportedBy: string }
): EmployeeMergeResult {
  const localById = new Map<string, Record<string, any>>();
  const erpToId = new Map<string, string>();
  for (const e of local) {
    if (!e?.employeeId) continue;
    localById.set(e.employeeId, e);
    const erp = String(e.erpId || '').trim();
    if (erp) erpToId.set(erp, e.employeeId);
  }
  const toPut: Record<string, any>[] = [];
  const conflicts: ConflictEntry[] = [];
  const blocked: ConflictEntry[] = [];
  let applied = 0;
  let skipped = 0;

  for (const inc of incoming) {
    const id = inc?.employeeId;
    if (!id || !inc?.fullName) {
      skipped += 1;
      continue;
    }
    const cur = localById.get(id);
    if (!cur) {
      const erp = String(inc.erpId || '').trim();
      if (erp && erpToId.has(erp) && erpToId.get(erp) !== id) {
        blocked.push({
          table: 'employees',
          pk: id,
          localAt: '',
          localBy: erpToId.get(erp) || '',
          incomingAt: incomingFile.exportedAt,
          incomingBy: incomingFile.exportedBy,
          winner: 'local',
          reason: `CHẶN NV mới ${id}: trùng mã ERP ${erp} với NV ${erpToId.get(erp)} — cần kieu xử lý tay, cấm tự động ghi đè`,
        });
        skipped += 1;
        continue;
      }
      toPut.push(inc);
      applied += 1;
      continue;
    }
    if (isSameRecordData(cur, inc)) {
      skipped += 1;
      continue;
    }
    const incAt = getRecordStamp(inc, incomingFile.exportedAt);
    const curAt = getRecordStamp(cur, incomingFile.exportedAt);
    if (incAt > curAt) {
      // Chặn đổi employeeId/erpId âm thầm? erpId đổi phải đi kèm stamp mới — cho qua nhưng log
      toPut.push(inc);
      applied += 1;
    } else if (incAt < curAt) {
      skipped += 1;
    } else {
      const incBy = getRecordAuthor(inc, incomingFile.exportedBy);
      const curBy = getRecordAuthor(cur, incomingFile.exportedBy);
      const winner = tieBreakWinner(incBy, curBy);
      conflicts.push({
        table: 'employees',
        pk: id,
        localAt: new Date(curAt).toISOString(),
        localBy: curBy,
        incomingAt: new Date(incAt).toISOString(),
        incomingBy: incBy,
        winner,
        reason: `NV ${id} cùng mốc giờ — ưu tiên ${winner === 'incoming' ? incBy : curBy}`,
      });
      if (winner === 'incoming') {
        toPut.push(inc);
        applied += 1;
      } else skipped += 1;
    }
  }
  return { toPut, applied, skipped, blocked, conflicts };
}

/** Union append-only theo id (audit logs, shift_submissions). */
export function unionById<T extends Record<string, any>>(local: T[], incoming: T[], idOf: (r: T) => string, limit = 0): { merged: T[]; added: number } {
  const seen = new Set(local.map(idOf).filter(Boolean));
  const merged = [...local];
  let added = 0;
  for (const r of incoming) {
    const id = idOf(r);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(r);
    added += 1;
  }
  if (limit > 0 && merged.length > limit) {
    // Giữ bản mới nhất theo timestamp nếu có
    merged.sort((a, b) => String((b as any).submittedAt || (b as any).timestamp || '').localeCompare(String((a as any).submittedAt || (a as any).timestamp || '')));
    return { merged: merged.slice(0, limit), added };
  }
  return { merged, added };
}

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface DeptFilePayload {
  kind: 'dept';
  schemaVersion: string;
  department: DeptScope;
  owner: string;
  exportedBy: string;
  exportedAt: string;
  baseMasterVersion: number;
  shiftRosters: Record<string, any>[];
  productivityQualityRates: Record<string, any>[];
  leaveRequests: Record<string, any>[];
  auditLogs: Record<string, any>[];
}

export interface MasterFilePayload {
  kind: 'master';
  schemaVersion: string;
  masterVersion: number;
  baseMasterVersion: number;
  exportedBy: string;
  exportedAt: string;
  employees: Record<string, any>[];
  dailyTimesheets: Record<string, any>[];
  overtimeRecords: Record<string, any>[];
  leaveRequests: Record<string, any>[];
  shiftRosters: Record<string, any>[];
  ocrScans: Record<string, any>[];
  systemSettings: any;
  shiftSubmissions: Record<string, any>[];
  shiftClasses: Record<string, any>[];
  rbacRoles: Record<string, any>[];
  productionLines: Record<string, any>[];
  productivityQualityRates: Record<string, any>[];
  auditLogs: Record<string, any>[];
}

export interface LocalSyncState {
  myMasterVersion: number;
  lastSeenMaster: Record<string, { version: number; exportedAt: string; exportedBy: string }>;
  lastSeenDept: Record<string, { exportedAt: string; exportedBy: string }>;
  lastMergeAt: string;
  lastScanAt: string;
}

export const EMPTY_SYNC_STATE: LocalSyncState = {
  myMasterVersion: 0,
  lastSeenMaster: {},
  lastSeenDept: {},
  lastMergeAt: '',
  lastScanAt: '',
};

export function validateDeptPayload(raw: unknown): DeptFilePayload {
  if (!raw || typeof raw !== 'object') throw new Error('File dept không phải JSON hợp lệ.');
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'dept') throw new Error('File không phải loại dept (kind != dept).');
  const department = o.department as string;
  if (department !== 'WH' && department !== 'QC' && department !== 'Production') {
    throw new Error(`Phòng ban trong file dept không hợp lệ: ${String(department)}`);
  }
  const mustArray = (k: string): Record<string, any>[] => {
    const v = o[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`Trường ${k} phải là mảng.`);
    return v as Record<string, any>[];
  };
  return {
    kind: 'dept',
    schemaVersion: String(o.schemaVersion || JSON_SYNC_SCHEMA_VERSION),
    department: department as DeptScope,
    owner: String(o.owner || o.exportedBy || ''),
    exportedBy: String(o.exportedBy || o.owner || ''),
    exportedAt: String(o.exportedAt || nowIso()),
    baseMasterVersion: Number(o.baseMasterVersion || 0),
    shiftRosters: mustArray('shiftRosters'),
    productivityQualityRates: mustArray('productivityQualityRates'),
    leaveRequests: mustArray('leaveRequests'),
    auditLogs: mustArray('auditLogs'),
  };
}

export function validateMasterPayload(raw: unknown): MasterFilePayload {
  if (!raw || typeof raw !== 'object') throw new Error('File master không phải JSON hợp lệ.');
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'master') throw new Error('File không phải loại master (kind != master).');
  const mustArray = (k: string): Record<string, any>[] => {
    const v = o[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`Trường ${k} phải là mảng.`);
    return v as Record<string, any>[];
  };
  return {
    kind: 'master',
    schemaVersion: String(o.schemaVersion || JSON_SYNC_SCHEMA_VERSION),
    masterVersion: Number(o.masterVersion || 0),
    baseMasterVersion: Number(o.baseMasterVersion || 0),
    exportedBy: String(o.exportedBy || ''),
    exportedAt: String(o.exportedAt || nowIso()),
    employees: mustArray('employees'),
    dailyTimesheets: mustArray('dailyTimesheets'),
    overtimeRecords: mustArray('overtimeRecords'),
    leaveRequests: mustArray('leaveRequests'),
    shiftRosters: mustArray('shiftRosters'),
    ocrScans: mustArray('ocrScans'),
    systemSettings: (o.systemSettings as any) ?? undefined,
    shiftSubmissions: mustArray('shiftSubmissions'),
    shiftClasses: mustArray('shiftClasses'),
    rbacRoles: mustArray('rbacRoles'),
    productionLines: mustArray('productionLines'),
    productivityQualityRates: mustArray('productivityQualityRates'),
    auditLogs: mustArray('auditLogs'),
  };
}

// ---------------------------------------------------------------------------
// Folder access — cấp quyền 1 lần, dùng lại nhiều lần
// ---------------------------------------------------------------------------

function openDirDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB không khả dụng'));
    const req = indexedDB.open(JSON_SYNC_DIR_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(JSON_SYNC_DIR_STORE)) {
        req.result.createObjectStore(JSON_SYNC_DIR_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

type SyncStatusListener = (s: FolderSyncStatus) => void;

export interface FolderSyncStatus {
  supported: boolean;
  hasHandle: boolean;
  granted: boolean;
  folderName: string;
  lastScanAt: string;
  pendingDept: number;
  pendingMaster: number;
  conflictFiles: number;
  lastError: string;
}

class JsonSyncFolder {
  private dirHandle: FileSystemDirectoryHandle | null = null;
  private granted = false;
  private listeners = new Set<SyncStatusListener>();
  private lastScan: FolderSyncStatus | null = null;

  constructor() {
    void this.restore();
  }

  isSupported(): boolean {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  hasHandle(): boolean {
    return this.dirHandle !== null;
  }

  isGranted(): boolean {
    return this.granted;
  }

  getFolderName(): string {
    try {
      return this.dirHandle ? this.dirHandle.name : '';
    } catch {
      return '';
    }
  }

  onStatus(fn: SyncStatusListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(partial: Partial<FolderSyncStatus>): void {
    const base: FolderSyncStatus = this.lastScan || {
      supported: this.isSupported(),
      hasHandle: this.hasHandle(),
      granted: this.isGranted(),
      folderName: this.getFolderName(),
      lastScanAt: '',
      pendingDept: 0,
      pendingMaster: 0,
      conflictFiles: 0,
      lastError: '',
    };
    this.lastScan = {
      ...base,
      ...partial,
      supported: this.isSupported(),
      hasHandle: this.hasHandle(),
      granted: this.isGranted(),
      folderName: this.getFolderName(),
    };
    this.listeners.forEach((fn) => {
      try {
        fn({ ...(this.lastScan as FolderSyncStatus) });
      } catch {
        /* ignore */
      }
    });
  }

  async restore(): Promise<boolean> {
    if (!this.isSupported()) return false;
    try {
      const idb = await openDirDb();
      const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve) => {
        try {
          const tx = idb.transaction(JSON_SYNC_DIR_STORE, 'readonly');
          const rq = tx.objectStore(JSON_SYNC_DIR_STORE).get(JSON_SYNC_DIR_KEY);
          rq.onsuccess = () => resolve((rq.result as FileSystemDirectoryHandle) || null);
          rq.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      if (handle) {
        this.dirHandle = handle;
        this.granted = await this.queryGranted();
        this.emit({});
        return this.granted;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  private async queryGranted(): Promise<boolean> {
    if (!this.dirHandle) return false;
    try {
      const h = this.dirHandle as any;
      if (typeof h.queryPermission === 'function') {
        return (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 1-click: nếu đã có handle chỉ xin quyền, chưa có mới mở picker. */
  async connect(): Promise<boolean> {
    if (!this.isSupported()) throw new Error('Trình duyệt không hỗ trợ chọn thư mục (cần Microsoft Edge/Chrome).');
    try {
      if (this.dirHandle) {
        const h = this.dirHandle as any;
        if (typeof h.requestPermission === 'function') {
          const p = await h.requestPermission({ mode: 'readwrite' });
          this.granted = p === 'granted';
          this.emit({});
          if (this.granted) return true;
        } else {
          this.granted = true;
          this.emit({});
          return true;
        }
      }
      return await this.pickDirectory();
    } catch (e: any) {
      if (e?.name === 'AbortError') return false;
      throw e;
    }
  }

  async pickDirectory(): Promise<boolean> {
    if (!this.isSupported()) throw new Error('Trình duyệt không hỗ trợ chọn thư mục.');
    const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
    if (!handle) return false;
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('Bạn chưa cấp quyền đọc/ghi cho thư mục đồng bộ.');
    this.dirHandle = handle;
    this.granted = true;
    try {
      const idb = await openDirDb();
      await new Promise<void>((resolve, reject) => {
        const tx = idb.transaction(JSON_SYNC_DIR_STORE, 'readwrite');
        tx.objectStore(JSON_SYNC_DIR_STORE).put(handle, JSON_SYNC_DIR_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* lưu handle thất bại vẫn dùng được trong phiên */
    }
    this.emit({});
    return true;
  }

  async ensureOk(): Promise<boolean> {
    if (!this.dirHandle) return false;
    if (this.granted) return true;
    this.granted = await this.queryGranted();
    this.emit({});
    return this.granted;
  }

  async listFiles(): Promise<{ name: string; lastModified: number; size: number }[]> {
    if (!this.dirHandle) return [];
    const ok = await this.ensureOk();
    if (!ok) return [];
    const out: { name: string; lastModified: number; size: number }[] = [];
    try {
      for await (const [name, handle] of (this.dirHandle as any).entries()) {
        if ((handle as any).kind !== 'file' || !name.endsWith('.json')) continue;
        try {
          const f = await (handle as FileSystemFileHandle).getFile();
          out.push({ name, lastModified: f.lastModified, size: f.size });
        } catch {
          /* bỏ qua file đang sync dở */
        }
      }
    } catch (e: any) {
      this.emit({ lastError: e?.message || 'Không đọc được thư mục' });
    }
    return out;
  }

  async readJson(name: string): Promise<any> {
    if (!this.dirHandle) throw new Error('Chưa kết nối thư mục đồng bộ.');
    const ok = await this.ensureOk();
    if (!ok) throw new Error('Chưa được cấp quyền đọc/ghi thư mục. Bấm "Kết nối thư mục" 1 lần.');
    const fh = await this.dirHandle.getFileHandle(name);
    const file = await fh.getFile();
    const text = await file.text();
    if (!text.trim()) throw new Error(`File ${name} rỗng.`);
    return JSON.parse(text);
  }

  async writeJson(name: string, obj: unknown): Promise<void> {
    if (!this.dirHandle) throw new Error('Chưa kết nối thư mục đồng bộ.');
    const ok = await this.ensureOk();
    if (!ok) throw new Error('Chưa được cấp quyền đọc/ghi thư mục. Bấm "Kết nối thư mục" 1 lần.');
    const fh = await this.dirHandle.getFileHandle(name, { create: true });
    const w = await (fh as any).createWritable();
    await w.write(JSON.stringify(obj, null, 2));
    await w.close();
  }
}

// ---------------------------------------------------------------------------
// Sync state trong Dexie (local-only)
// ---------------------------------------------------------------------------

export async function getLocalSyncState(): Promise<LocalSyncState> {
  try {
    const row = await db.settings.get(JSON_SYNC_STATE_KEY);
    if (row?.value && typeof row.value === 'object') return { ...EMPTY_SYNC_STATE, ...(row.value as LocalSyncState) };
  } catch {
    /* ignore */
  }
  return { ...EMPTY_SYNC_STATE };
}

export async function saveLocalSyncState(s: LocalSyncState): Promise<void> {
  await db.settings.put({ key: JSON_SYNC_STATE_KEY, value: s });
}

// ---------------------------------------------------------------------------
// Main service
// ---------------------------------------------------------------------------

export interface ScanItem {
  file: string;
  kind: 'master' | 'dept' | 'conflict-copy' | 'unknown';
  exportedBy: string;
  exportedAt: string;
  version: number;
  isPending: boolean;
  note: string;
}

export interface ScanResult {
  scannedAt: string;
  items: ScanItem[];
  pendingDept: ScanItem[];
  pendingMaster: ScanItem[];
  conflictCopies: string[];
}

export interface IngestResult {
  file: string;
  applied: number;
  skipped: number;
  conflicts: ConflictEntry[];
  blocked: ConflictEntry[];
  note: string;
}

class JsonSyncService {
  readonly folder = new JsonSyncFolder();
  private scanTimer: any = null;
  private scanning = false;

  getDeptFilename(username: string): string | null {
    return DEPT_FILE_BY_USER[username.toLowerCase()] || null;
  }

  getMasterFilename(username: string): string | null {
    return MASTER_FILE_BY_USER[username.toLowerCase()] || null;
  }

  getDeptScope(username: string): DeptScope | null {
    return DEPT_SCOPE_BY_USER[username.toLowerCase()] || null;
  }

  isMasterUser(username: string): boolean {
    const u = username.toLowerCase();
    return u === 'kieu' || u === 'hoa' || u === 'glory';
  }

  // -- Export dept (vinh/nguyetanh/han) -------------------------------------
  async exportDeptFile(username: string, displayName: string): Promise<{ file: string; counts: Record<string, number> }> {
    const u = username.toLowerCase();
    const dept = this.getDeptScope(u);
    const file = this.getDeptFilename(u);
    if (!dept || !file) throw new Error(`Tài khoản ${username} không phải Dept Admin (vinh/nguyetanh/han).`);
    const state = await getLocalSyncState();

    const rosters = await db.shiftRosters.where('department').equals(dept).toArray().catch(async () => {
      const all = await db.shiftRosters.toArray();
      return all.filter((r: any) => r.department === dept);
    });
    const rates = await db.productivityQualityRates.toArray();
    const leavesAll = await db.leaveRequests.toArray();
    const leaves = leavesAll.filter((l: any) => l.department === dept);
    const auditsAll = await db.userAuditLogs.toArray().catch(() => [] as any[]);
    const audits = auditsAll.filter((a: any) => String(a.username || '').toLowerCase() === u).slice(-200);

    // Stamp truy vết trước khi ghi file (không đổi PK)
    const at = nowIso();
    for (const r of rosters as any[]) if (!r._sync) stampSyncMeta(r, u, at);
    for (const r of rates as any[]) if (!r._sync) stampSyncMeta(r, u, at);

    const payload: DeptFilePayload = {
      kind: 'dept',
      schemaVersion: JSON_SYNC_SCHEMA_VERSION,
      department: dept,
      owner: u,
      exportedBy: u,
      exportedAt: at,
      baseMasterVersion: state.myMasterVersion,
      shiftRosters: rosters as any[],
      productivityQualityRates: rates as any[],
      leaveRequests: leaves as any[],
      auditLogs: audits as any[],
    };
    await this.folder.writeJson(file, payload);

    state.lastSeenDept[file] = { exportedAt: at, exportedBy: u };
    state.lastScanAt = at;
    await saveLocalSyncState(state);
    this.folder.emit({});

    await logUserAction({
      username: u,
      displayName,
      role: (await db.accounts.get(u))?.role || 'Warehouse Admin',
      actionType: 'ASSIGN_SHIFT',
      targetEntity: `${dept} (${rosters.length} ca)`,
      details: `Xuất file dept ${file} lên thư mục đồng bộ (thuần JSON, ${rosters.length} ca + ${rates.length} rates)`,
    }).catch(() => {});

    return { file, counts: { shiftRosters: rosters.length, rates: rates.length, leaves: leaves.length } };
  }

  // -- Ghi nhanh 1 đợt ca của dept (local + dept file) ------------------------
  async submitDeptShifts(input: {
    username: string;
    displayName: string;
    department: string;
    rosters: Record<string, any>[];
    entries?: [string, string][];
    dateRange?: string[];
  }): Promise<{ file: string | null; viaFolder: boolean; localCount: number }> {
    const u = input.username.toLowerCase();
    const dept = (this.getDeptScope(u) || input.department) as string;
    const at = nowIso();

    const stamped = (input.rosters || []).map((r: any) => {
      const c = { ...r, department: r.department || dept };
      return stampSyncMeta(c, u, at);
    });

    await db.transaction('rw', db.shiftRosters, db.employees, async () => {
      if (stamped.length) await db.shiftRosters.bulkPut(stamped as any);
      if (input.entries?.length) {
        for (const [empId, shiftCode] of input.entries) {
          try {
            await db.employees.update(empId, { shiftClassId: shiftCode } as any);
          } catch {
            /* ignore */
          }
        }
      }
    });

    // Ghi lịch sử nộp ca (local)
    try {
      const existing = await db.settings.get('shift_submissions');
      const list: any[] = existing?.value || [];
      list.unshift({
        id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        department: dept,
        senderUsername: u,
        senderName: input.displayName,
        submittedAt: at,
        employeeCount: input.entries?.length || new Set(stamped.map((r: any) => r.employeeId)).size,
        rosterCount: stamped.length,
        dateRange: input.dateRange || [],
        via: 'json-dept-file',
      });
      await db.settings.put({ key: 'shift_submissions', value: list.slice(0, 50) });
    } catch {
      /* ignore */
    }

    let file: string | null = this.getDeptFilename(u);
    let viaFolder = false;
    if (file && this.folder.hasHandle() && this.folder.isGranted()) {
      try {
        await this.exportDeptFile(u, input.displayName);
        viaFolder = true;
      } catch {
        viaFolder = false;
      }
    }
    return { file, viaFolder, localCount: stamped.length };
  }

  // -- Export master (kieu/hoa) ------------------------------------------------
  async exportMasterFile(username: string): Promise<{ file: string; masterVersion: number }> {
    const u = username.toLowerCase();
    const file = this.getMasterFilename(u);
    if (!file) throw new Error(`Tài khoản ${username} không thuộc nhóm master (kieu/hoa).`);
    const state = await getLocalSyncState();
    const at = nowIso();

    // Version của tôi = max(đã có, version mới nhất từng thấy của chính mình) + 1
    const seenMine = state.lastSeenMaster[file]?.version || 0;
    const masterVersion = Math.max(state.myMasterVersion, seenMine) + 1;

    const otherVersions = Object.entries(state.lastSeenMaster)
      .filter(([k]) => k !== file)
      .map(([, v]) => v.version || 0);
    const baseMasterVersion = Math.max(0, ...otherVersions);

    const sysRow = await db.settings.get('systemSettings').catch(() => undefined);
    const subsRow = await db.settings.get('shift_submissions').catch(() => undefined);

    // Stamp các record thiếu _sync để lần merge sau biết tác giả (ghi thẳng vào Dexie 1 lần)
    await this.stampLocalRecords(u, at).catch(() => {});

    const payload: MasterFilePayload = {
      kind: 'master',
      schemaVersion: JSON_SYNC_SCHEMA_VERSION,
      masterVersion,
      baseMasterVersion,
      exportedBy: u,
      exportedAt: at,
      employees: (await db.employees.toArray()) as any[],
      dailyTimesheets: (await db.dailyTimesheets.toArray()) as any[],
      overtimeRecords: (await db.overtimeRecords.toArray()) as any[],
      leaveRequests: (await db.leaveRequests.toArray()) as any[],
      shiftRosters: (await db.shiftRosters.toArray()) as any[],
      ocrScans: (await db.ocrScans.toArray()) as any[],
      systemSettings: sysRow?.value,
      shiftSubmissions: (subsRow?.value as any[]) || [],
      shiftClasses: await db.shiftClasses.toArray().catch(() => [] as any[]),
      rbacRoles: await db.rbacRoles.toArray().catch(() => [] as any[]),
      productionLines: await db.productionLines.toArray().catch(() => [] as any[]),
      productivityQualityRates: await db.productivityQualityRates.toArray().catch(() => [] as any[]),
      auditLogs: await db.userAuditLogs.toArray().catch(() => [] as any[]),
    };
    await this.folder.writeJson(file, payload);

    state.myMasterVersion = masterVersion;
    state.lastSeenMaster[file] = { version: masterVersion, exportedAt: at, exportedBy: u };
    state.lastScanAt = at;
    await saveLocalSyncState(state);
    this.folder.emit({});
    return { file, masterVersion };
  }

  /** Gắn _sync còn thiếu cho record local (chạy trước khi export master để truy vết kieu/hoa). */
  private async stampLocalRecords(username: string, at: string): Promise<void> {
    const u = username.toLowerCase();
    const tables: Array<{ name: 'shiftRosters' | 'productivityQualityRates' | 'leaveRequests' | 'dailyTimesheets' | 'overtimeRecords' | 'employees'; pk: string }> = [
      { name: 'shiftRosters', pk: 'employeeId_date' },
      { name: 'productivityQualityRates', pk: 'lineId_date' },
      { name: 'leaveRequests', pk: 'id' },
      { name: 'dailyTimesheets', pk: 'employeeId_date' },
      { name: 'overtimeRecords', pk: 'employeeId_date' },
      { name: 'employees', pk: 'employeeId' },
    ];
    for (const t of tables) {
      try {
        const all = await (db as any)[t.name].toArray();
        const missing = all.filter((r: any) => r && !r._sync);
        for (const r of missing) {
          try {
            await (db as any)[t.name].update(r[t.pk], { _sync: { at, by: u } });
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // -- Quét thư mục -------------------------------------------------------------
  async scanFolder(): Promise<ScanResult> {
    const state = await getLocalSyncState();
    const scannedAt = nowIso();
    const files = await this.folder.listFiles();
    const items: ScanItem[] = [];
    const conflictCopies = files.filter((f) => /conflict/i.test(f.name)).map((f) => f.name);

    for (const f of files) {
      const lower = f.name.toLowerCase();
      const isKnownMaster = KNOWN_SYNC_FILES.includes(f.name) && f.name.startsWith('master_');
      const isKnownDept = KNOWN_SYNC_FILES.includes(f.name) && f.name.startsWith('dept_');
      if (!isKnownMaster && !isKnownDept) {
        if (/conflict/i.test(f.name)) {
          items.push({ file: f.name, kind: 'conflict-copy', exportedBy: '', exportedAt: '', version: 0, isPending: true, note: 'OneDrive conflict copy — cần kieu xử lý tay' });
        }
        continue;
      }
      try {
        const raw = await this.folder.readJson(f.name);
        if (raw?.kind === 'master') {
          const p = validateMasterPayload(raw);
          const seen = state.lastSeenMaster[f.name];
          const isPending = !seen || p.masterVersion > (seen.version || 0) || (p.exportedAt || '') > (seen.exportedAt || '');
          // Bỏ qua file do chính mình vừa xuất
          const mine = p.exportedBy.toLowerCase() === (await this.currentUsername()).toLowerCase() && p.masterVersion <= state.myMasterVersion && p.exportedAt <= (seen?.exportedAt || p.exportedAt);
          items.push({
            file: f.name,
            kind: 'master',
            exportedBy: p.exportedBy,
            exportedAt: p.exportedAt,
            version: p.masterVersion,
            isPending: mine ? false : isPending,
            note: `Master v${p.masterVersion} của ${p.exportedBy} (base v${p.baseMasterVersion})`,
          });
        } else if (raw?.kind === 'dept') {
          const p = validateDeptPayload(raw);
          const seen = state.lastSeenDept[f.name];
          const isPending = !seen || (p.exportedAt || '') > (seen.exportedAt || '');
          items.push({
            file: f.name,
            kind: 'dept',
            exportedBy: p.exportedBy,
            exportedAt: p.exportedAt,
            version: 0,
            isPending,
            note: `${p.department} của ${p.exportedBy}: ${p.shiftRosters.length} ca + ${p.productivityQualityRates.length} rates`,
          });
        }
      } catch (e: any) {
        items.push({ file: f.name, kind: 'unknown', exportedBy: '', exportedAt: '', version: 0, isPending: false, note: e?.message || 'Không đọc được file' });
      }
    }

    state.lastScanAt = scannedAt;
    await saveLocalSyncState(state).catch(() => {});
    const pendingDept = items.filter((i) => i.kind === 'dept' && i.isPending);
    const pendingMaster = items.filter((i) => i.kind === 'master' && i.isPending);
    this.folder.emit({ lastScanAt: scannedAt, pendingDept: pendingDept.length, pendingMaster: pendingMaster.length, conflictFiles: conflictCopies.length, lastError: '' });
    return { scannedAt, items, pendingDept, pendingMaster, conflictCopies };
  }

  private async currentUsername(): Promise<string> {
    try {
      const raw = sessionStorage.getItem('smarthr_session');
      if (raw) return (JSON.parse(raw) as any)?.username || '';
    } catch {
      /* ignore */
    }
    return '';
  }

  // -- Ingest dept (kieu/hoa tiếp nhận) ------------------------------------------
  async ingestDeptFile(file: string, actor: { username: string; displayName: string }): Promise<IngestResult> {
    const raw = await this.folder.readJson(file);
    const payload = validateDeptPayload(raw);

    // Ràng buộc: file dept phải đúng owner/scope, dept trong record phải khớp scope file
    const expectedOwner = Object.entries(DEPT_FILE_BY_USER).find(([, f]) => f === file)?.[0];
    if (expectedOwner && payload.exportedBy.toLowerCase() !== expectedOwner && payload.owner.toLowerCase() !== expectedOwner) {
      throw new Error(`File ${file} phải do ${expectedOwner} xuất. Thực tế: ${payload.exportedBy}. Từ chối để tránh nhầm user.`);
    }
    const badScope = payload.shiftRosters.filter((r: any) => r.department && r.department !== payload.department);
    if (badScope.length > 0) {
      throw new Error(`File ${file} lẫn ${badScope.length} ca khác phòng ${payload.department} — từ chối toàn file để bảo toàn dữ liệu.`);
    }
    if (payload.shiftRosters.some((r: any) => !r.employeeId_date || !r.employeeId || !r.date)) {
      throw new Error(`File ${file} thiếu khóa employeeId_date — từ chối để tránh ghi sai user.`);
    }

    const incomingFile = { exportedAt: payload.exportedAt, exportedBy: payload.exportedBy };
    const localRosters = await db.shiftRosters.toArray();
    const localRates = await db.productivityQualityRates.toArray().catch(() => [] as any[]);
    const localLeaves = await db.leaveRequests.toArray();
    const localAudits = await db.userAuditLogs.toArray().catch(() => [] as any[]);

    // Chỉ merge ca thuộc scope dept (dù file đã lọc, vẫn lọc lại lần nữa cho chắc)
    const scopedIncoming = payload.shiftRosters.filter((r: any) => (r.department || payload.department) === payload.department);
    const rosterMerge = mergeTableRecords('shiftRosters', localRosters as any[], scopedIncoming as any[], (r: any) => r.employeeId_date, incomingFile);

    const rateMerge = mergeQualityRates(localRates as any[], (payload.productivityQualityRates || []) as any[], incomingFile);

    const scopedLeaves = (payload.leaveRequests || []).filter((l: any) => !l.department || l.department === payload.department);
    const leaveMerge = mergeTableRecords('leaveRequests', localLeaves as any[], scopedLeaves as any[], (r: any) => r.id, incomingFile);

    const auditUnion = unionById(localAudits as any[], (payload.auditLogs || []) as any[], (r: any) => r.id);

    await db.transaction('rw', [db.shiftRosters, db.productivityQualityRates, db.leaveRequests, db.userAuditLogs], async () => {
      if (rosterMerge.toPut.length) await db.shiftRosters.bulkPut(rosterMerge.toPut as any);
      if (rateMerge.toPut.length) await db.productivityQualityRates.bulkPut(rateMerge.toPut as any);
      if (leaveMerge.toPut.length) await db.leaveRequests.bulkPut(leaveMerge.toPut as any);
      if (auditUnion.added > 0) {
        const fresh = await db.userAuditLogs.toArray().catch(() => [] as any[]);
        const u2 = unionById(fresh as any[], (payload.auditLogs || []) as any[], (r: any) => r.id);
        if (u2.added > 0) await db.userAuditLogs.bulkPut((payload.auditLogs || []) as any);
      }
    });

    // Lưu lịch sử tiếp nhận + audit
    const conflicts = [...rosterMerge.conflicts, ...rateMerge.conflicts, ...leaveMerge.conflicts];
    try {
      const row = await db.settings.get('shift_submissions');
      const list: any[] = row?.value || [];
      list.unshift({
        id: `ing_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        department: payload.department,
        senderUsername: payload.exportedBy,
        senderName: payload.exportedBy,
        submittedAt: payload.exportedAt,
        receivedAt: nowIso(),
        receivedBy: actor.username.toLowerCase(),
        employeeCount: new Set(scopedIncoming.map((r: any) => r.employeeId)).size,
        rosterCount: scopedIncoming.length,
        applied: rosterMerge.applied,
        via: `json-ingest:${file}`,
      });
      await db.settings.put({ key: 'shift_submissions', value: list.slice(0, 50) });
    } catch {
      /* ignore */
    }
    await logUserAction({
      username: actor.username.toLowerCase(),
      displayName: actor.displayName,
      role: (await db.accounts.get(actor.username.toLowerCase()))?.role || 'HR Manager',
      actionType: 'ASSIGN_SHIFT',
      targetEntity: `${payload.department} (${scopedIncoming.length} ca từ ${payload.exportedBy})`,
      details: `Tiếp nhận ${file}: áp dụng ${rosterMerge.applied} ca + ${rateMerge.applied} rates, bỏ qua ${rosterMerge.skipped + rateMerge.skipped}, conflict ${conflicts.length}`,
    }).catch(() => {});

    const state = await getLocalSyncState();
    state.lastSeenDept[file] = { exportedAt: payload.exportedAt, exportedBy: payload.exportedBy };
    state.lastMergeAt = nowIso();
    await saveLocalSyncState(state);

    return {
      file,
      applied: rosterMerge.applied + rateMerge.applied + leaveMerge.applied,
      skipped: rosterMerge.skipped + rateMerge.skipped + leaveMerge.skipped,
      conflicts,
      blocked: [],
      note: `Đã tiếp nhận ${payload.department} của ${payload.exportedBy}`,
    };
  }

  // -- Ingest master (kieu <-> hoa dual-merge) ------------------------------------
  async ingestMasterFile(file: string, actor: { username: string; displayName: string }): Promise<IngestResult> {
    const raw = await this.folder.readJson(file);
    const payload = validateMasterPayload(raw);
    const incomingFile = { exportedAt: payload.exportedAt, exportedBy: payload.exportedBy };

    // Cảnh báo ghi đồng thời: base của incoming < version master mới nhất mình từng thấy
    const state0 = await getLocalSyncState();
    const maxSeenMaster = Math.max(0, ...Object.values(state0.lastSeenMaster).map((v) => v.version || 0), state0.myMasterVersion);
    const concurrentNote =
      payload.baseMasterVersion < maxSeenMaster
        ? `CẢNH BÁO ghi đồng thời: file base v${payload.baseMasterVersion} < master mới nhất đã thấy v${maxSeenMaster} — merge LWW + rà conflict kỹ.`
        : '';

    const local = {
      employees: (await db.employees.toArray()) as any[],
      dailyTimesheets: (await db.dailyTimesheets.toArray()) as any[],
      overtimeRecords: (await db.overtimeRecords.toArray()) as any[],
      leaveRequests: (await db.leaveRequests.toArray()) as any[],
      shiftRosters: (await db.shiftRosters.toArray()) as any[],
      ocrScans: (await db.ocrScans.toArray()) as any[],
      shiftClasses: (await db.shiftClasses.toArray().catch(() => [] as any[])) as any[],
      rbacRoles: (await db.rbacRoles.toArray().catch(() => [] as any[])) as any[],
      productionLines: (await db.productionLines.toArray().catch(() => [] as any[])) as any[],
      productivityQualityRates: (await db.productivityQualityRates.toArray().catch(() => [] as any[])) as any[],
      auditLogs: (await db.userAuditLogs.toArray().catch(() => [] as any[])) as any[],
    };

    const empMerge = mergeEmployeesSafe(local.employees, payload.employees || [], incomingFile);
    const tsMerge = mergeTableRecords('dailyTimesheets', local.dailyTimesheets, payload.dailyTimesheets || [], (r: any) => r.employeeId_date, incomingFile);
    const otMerge = mergeTableRecords('overtimeRecords', local.overtimeRecords, payload.overtimeRecords || [], (r: any) => r.employeeId_date, incomingFile);
    const leaveMerge = mergeTableRecords('leaveRequests', local.leaveRequests, payload.leaveRequests || [], (r: any) => r.id, incomingFile);
    const rosterMerge = mergeTableRecords('shiftRosters', local.shiftRosters, payload.shiftRosters || [], (r: any) => r.employeeId_date, incomingFile);
    const ocrMerge = mergeTableRecords('ocrScans', local.ocrScans, payload.ocrScans || [], (r: any) => r.id, incomingFile);
    const rateMerge = mergeQualityRates(local.productivityQualityRates, payload.productivityQualityRates || [], incomingFile);
    // Master-only tables: kieu thắng khi hòa (bảo vệ master data)
    const scMerge = mergeTableRecords('shiftClasses', local.shiftClasses, payload.shiftClasses || [], (r: any) => r.shiftClassId, incomingFile);
    const rbacMerge = mergeTableRecords('rbacRoles', local.rbacRoles, payload.rbacRoles || [], (r: any) => r.roleId, incomingFile);
    const plMerge = mergeTableRecords('productionLines', local.productionLines, payload.productionLines || [], (r: any) => r.id, incomingFile);
    const auditUnion = unionById(local.auditLogs, payload.auditLogs || [], (r: any) => r.id);

    // systemSettings + shift_submissions
    let settingsChanged = false;
    let mergedSettings: any = undefined;
    try {
      const curRow = await db.settings.get('systemSettings');
      const cur = curRow?.value;
      if (payload.systemSettings && JSON.stringify(cur) !== JSON.stringify(payload.systemSettings)) {
        // Hòa/khác: kieu thắng. Nếu incoming là kieu -> lấy incoming; nếu mình là kieu và incoming là hoa -> giữ local
        const incBy = payload.exportedBy.toLowerCase();
        const me = actor.username.toLowerCase();
        if (incBy === 'kieu' || (me !== 'kieu' && incBy === me)) {
          mergedSettings = payload.systemSettings;
          settingsChanged = true;
        } else if (me === 'kieu') {
          settingsChanged = false; // kieu giữ bản local, log conflict
        } else {
          // hoa vs hoa: LWW theo exportedAt
          const curAt = toMs((cur as any)?.updatedAt, 0);
          const incAt = toMs(payload.exportedAt, 0);
          if (incAt >= curAt) {
            mergedSettings = payload.systemSettings;
            settingsChanged = true;
          }
        }
      }
    } catch {
      /* ignore */
    }
    const subsRow = await db.settings.get('shift_submissions').catch(() => undefined);
    const subsUnion = unionById((subsRow?.value as any[]) || [], payload.shiftSubmissions || [], (r: any) => r.id, 50);

    await db.transaction(
      'rw',
      [db.employees, db.dailyTimesheets, db.overtimeRecords, db.leaveRequests, db.shiftRosters, db.ocrScans, db.settings, db.shiftClasses, db.rbacRoles, db.productionLines, db.productivityQualityRates, db.userAuditLogs],
      async () => {
        if (empMerge.toPut.length) await db.employees.bulkPut(empMerge.toPut as any);
        if (tsMerge.toPut.length) await db.dailyTimesheets.bulkPut(tsMerge.toPut as any);
        if (otMerge.toPut.length) await db.overtimeRecords.bulkPut(otMerge.toPut as any);
        if (leaveMerge.toPut.length) await db.leaveRequests.bulkPut(leaveMerge.toPut as any);
        if (rosterMerge.toPut.length) await db.shiftRosters.bulkPut(rosterMerge.toPut as any);
        if (ocrMerge.toPut.length) await db.ocrScans.bulkPut(ocrMerge.toPut as any);
        if (scMerge.toPut.length) await db.shiftClasses.bulkPut(scMerge.toPut as any);
        if (rbacMerge.toPut.length) await db.rbacRoles.bulkPut(rbacMerge.toPut as any);
        if (plMerge.toPut.length) await db.productionLines.bulkPut(plMerge.toPut as any);
        if (rateMerge.toPut.length) await db.productivityQualityRates.bulkPut(rateMerge.toPut as any);
        if (auditUnion.added > 0) await db.userAuditLogs.bulkPut((payload.auditLogs || []) as any).catch(() => {});
        if (settingsChanged && mergedSettings) await db.settings.put({ key: 'systemSettings', value: mergedSettings });
        await db.settings.put({ key: 'shift_submissions', value: subsUnion.merged });
      }
    );

    const conflicts: ConflictEntry[] = [
      ...empMerge.conflicts,
      ...tsMerge.conflicts,
      ...otMerge.conflicts,
      ...leaveMerge.conflicts,
      ...rosterMerge.conflicts,
      ...ocrMerge.conflicts,
      ...rateMerge.conflicts,
      ...scMerge.conflicts,
      ...rbacMerge.conflicts,
      ...plMerge.conflicts,
    ];
    const applied = empMerge.applied + tsMerge.applied + otMerge.applied + leaveMerge.applied + rosterMerge.applied + ocrMerge.applied + rateMerge.applied + scMerge.applied + rbacMerge.applied + plMerge.applied + auditUnion.added + (settingsChanged ? 1 : 0);
    const skipped = empMerge.skipped + tsMerge.skipped + otMerge.skipped + leaveMerge.skipped + rosterMerge.skipped + ocrMerge.skipped + rateMerge.skipped + scMerge.skipped + rbacMerge.skipped + plMerge.skipped;

    await logUserAction({
      username: actor.username.toLowerCase(),
      displayName: actor.displayName,
      role: (await db.accounts.get(actor.username.toLowerCase()))?.role || 'HR Manager',
      actionType: 'TIMESHEET_EDIT',
      targetEntity: `master ${file} v${payload.masterVersion} (${payload.exportedBy})`,
      details: `Dual-merge master: áp dụng ${applied}, bỏ qua ${skipped}, conflict ${conflicts.length}, chặn NV ${empMerge.blocked.length}. ${concurrentNote}`,
    }).catch(() => {});

    const state = await getLocalSyncState();
    state.lastSeenMaster[file] = { version: payload.masterVersion, exportedAt: payload.exportedAt, exportedBy: payload.exportedBy };
    state.lastMergeAt = nowIso();
    await saveLocalSyncState(state);

    return {
      file,
      applied,
      skipped,
      conflicts,
      blocked: empMerge.blocked,
      note: `Đã merge master v${payload.masterVersion} của ${payload.exportedBy}. ${concurrentNote}`,
    };
  }

  // -- Manual fallback (tải file / upload file, không cần thư mục) -----------------
  downloadJson(filename: string, obj: unknown): void {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async buildDeptPayloadForDownload(username: string): Promise<{ filename: string; payload: DeptFilePayload }> {
    const u = username.toLowerCase();
    const dept = this.getDeptScope(u);
    if (!dept) throw new Error('Chỉ Dept Admin mới xuất file dept.');
    const state = await getLocalSyncState();
    const at = nowIso();
    const rosters = (await db.shiftRosters.toArray()).filter((r: any) => r.department === dept);
    const rates = await db.productivityQualityRates.toArray().catch(() => [] as any[]);
    const leaves = (await db.leaveRequests.toArray()).filter((l: any) => l.department === dept);
    const audits = ((await db.userAuditLogs.toArray().catch(() => [] as any[])) as any[]).filter((a: any) => String(a.username || '').toLowerCase() === u).slice(-200);
    const filename = DEPT_FILE_BY_USER[u];
    return {
      filename,
      payload: {
        kind: 'dept',
        schemaVersion: JSON_SYNC_SCHEMA_VERSION,
        department: dept,
        owner: u,
        exportedBy: u,
        exportedAt: at,
        baseMasterVersion: state.myMasterVersion,
        shiftRosters: rosters as any[],
        productivityQualityRates: rates as any[],
        leaveRequests: leaves as any[],
        auditLogs: audits as any[],
      },
    };
  }

  async buildMasterPayloadForDownload(username: string): Promise<{ filename: string; payload: MasterFilePayload }> {
    const u = username.toLowerCase();
    const file = this.getMasterFilename(u);
    if (!file) throw new Error('Chỉ kieu/hoa mới xuất master.');
    const state = await getLocalSyncState();
    const at = nowIso();
    const sysRow = await db.settings.get('systemSettings').catch(() => undefined);
    const subsRow = await db.settings.get('shift_submissions').catch(() => undefined);
    return {
      filename: `${file.replace('.json', '')}_${at.slice(0, 10)}.json`,
      payload: {
        kind: 'master',
        schemaVersion: JSON_SYNC_SCHEMA_VERSION,
        masterVersion: state.myMasterVersion + 1,
        baseMasterVersion: Math.max(0, ...Object.values(state.lastSeenMaster).map((v) => v.version || 0)),
        exportedBy: u,
        exportedAt: at,
        employees: (await db.employees.toArray()) as any[],
        dailyTimesheets: (await db.dailyTimesheets.toArray()) as any[],
        overtimeRecords: (await db.overtimeRecords.toArray()) as any[],
        leaveRequests: (await db.leaveRequests.toArray()) as any[],
        shiftRosters: (await db.shiftRosters.toArray()) as any[],
        ocrScans: (await db.ocrScans.toArray()) as any[],
        systemSettings: sysRow?.value,
        shiftSubmissions: (subsRow?.value as any[]) || [],
        shiftClasses: await db.shiftClasses.toArray().catch(() => [] as any[]),
        rbacRoles: await db.rbacRoles.toArray().catch(() => [] as any[]),
        productionLines: await db.productionLines.toArray().catch(() => [] as any[]),
        productivityQualityRates: await db.productivityQualityRates.toArray().catch(() => [] as any[]),
        auditLogs: await db.userAuditLogs.toArray().catch(() => [] as any[]),
      },
    };
  }

  /** Import từ File upload thủ công (tự phát hiện kind dept/master). */
  async importFromJsonObject(raw: unknown, actor: { username: string; displayName: string }): Promise<IngestResult> {
    const o = raw as Record<string, unknown>;
    if ((o as any)?.kind === 'dept') {
      const p = validateDeptPayload(raw);
      const file = DEPT_FILE_BY_USER[p.exportedBy.toLowerCase()] || `dept_${p.department}_${p.exportedBy}.json`;
      // Ghi tạm vào bộ nhớ rồi ingest qua cùng pipeline (không cần folder): merge trực tiếp
      return await this.ingestDeptObject(file, p, actor);
    }
    if ((o as any)?.kind === 'master') {
      const p = validateMasterPayload(raw);
      return await this.ingestMasterObject(`master_${p.exportedBy}.json`, p, actor);
    }
    throw new Error('File JSON không phải dept hay master của hệ thống (thiếu kind).');
  }

  /** Merge dept object trực tiếp (dùng cho upload tay, không qua folder). */
  async ingestDeptObject(file: string, payload: DeptFilePayload, actor: { username: string; displayName: string }): Promise<IngestResult> {
    const incomingFile = { exportedAt: payload.exportedAt, exportedBy: payload.exportedBy };
    const localRosters = await db.shiftRosters.toArray();
    const localRates = await db.productivityQualityRates.toArray().catch(() => [] as any[]);
    const localLeaves = await db.leaveRequests.toArray();
    const scopedIncoming = payload.shiftRosters.filter((r: any) => (r.department || payload.department) === payload.department);
    const rosterMerge = mergeTableRecords('shiftRosters', localRosters as any[], scopedIncoming as any[], (r: any) => r.employeeId_date, incomingFile);
    const rateMerge = mergeQualityRates(localRates as any[], (payload.productivityQualityRates || []) as any[], incomingFile);
    const scopedLeaves = (payload.leaveRequests || []).filter((l: any) => !l.department || l.department === payload.department);
    const leaveMerge = mergeTableRecords('leaveRequests', localLeaves as any[], scopedLeaves as any[], (r: any) => r.id, incomingFile);
    await db.transaction('rw', [db.shiftRosters, db.productivityQualityRates, db.leaveRequests, db.userAuditLogs], async () => {
      if (rosterMerge.toPut.length) await db.shiftRosters.bulkPut(rosterMerge.toPut as any);
      if (rateMerge.toPut.length) await db.productivityQualityRates.bulkPut(rateMerge.toPut as any);
      if (leaveMerge.toPut.length) await db.leaveRequests.bulkPut(leaveMerge.toPut as any);
      if ((payload.auditLogs || []).length) await db.userAuditLogs.bulkPut(payload.auditLogs as any).catch(() => {});
    });
    const state = await getLocalSyncState();
    state.lastSeenDept[file] = { exportedAt: payload.exportedAt, exportedBy: payload.exportedBy };
    state.lastMergeAt = nowIso();
    await saveLocalSyncState(state);
    const conflicts = [...rosterMerge.conflicts, ...rateMerge.conflicts, ...leaveMerge.conflicts];
    return { file, applied: rosterMerge.applied + rateMerge.applied + leaveMerge.applied, skipped: rosterMerge.skipped + rateMerge.skipped + leaveMerge.skipped, conflicts, blocked: [], note: `Upload tay ${file}` };
  }

  async ingestMasterObject(file: string, payload: MasterFilePayload, actor: { username: string; displayName: string }): Promise<IngestResult> {
    // Tái sử dụng pipeline ingestMasterFile bằng cách ghi tạm? Đơn giản: lưu payload vào biến tạm rồi gọi logic chung.
    // Để tránh đọc folder, tạm ghi đè readJson:
    const origRead = this.folder.readJson.bind(this.folder);
    (this.folder as any).readJson = async () => payload;
    try {
      return await this.ingestMasterFile(file, actor);
    } finally {
      (this.folder as any).readJson = origRead;
    }
  }

  // -- Auto scan loop ---------------------------------------------------------------
  startAutoScan(onResult: (r: ScanResult) => void, intervalMs = 8000): () => void {
    this.stopAutoScan();
    const tick = async () => {
      if (this.scanning || !this.folder.hasHandle() || !this.folder.isGranted()) return;
      this.scanning = true;
      try {
        const r = await this.scanFolder();
        onResult(r);
      } catch {
        /* ignore */
      } finally {
        this.scanning = false;
      }
    };
    void tick();
    this.scanTimer = setInterval(tick, Math.max(4000, intervalMs));
    return () => this.stopAutoScan();
  }

  stopAutoScan(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }
}

export const jsonSyncService = new JsonSyncService();
