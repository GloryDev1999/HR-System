/**
 * SmartHR — Data layer Supabase (thay Dexie src/db/index.ts).
 *
 * Mọi component trước đây dùng `useLiveQuery(() => db.X.toArray())` và
 * `db.X.put/bulkPut/update/delete/clear` giờ dùng module này:
 *   - `useLiveTable('dailyTimesheets')` → mảng camelCase, tự refresh realtime
 *   - `bulkUpsert / upsertOne / updateByKey / removeByKey / clearTable`
 *
 * Quy ước mapping: cột Postgres snake_case ↔ field code camelCase
 * (VD employee_id ↔ employeeId). JSONB (customAllowances...) giữ nguyên keys.
 * Cột TIME 'HH:mm:ss' từ Postgres được tỉa về 'HH:mm' cho khớp UI cũ.
 */
import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';

export type StoreKey =
  | 'employees'
  | 'rawAttendanceLogs'
  | 'dailyTimesheets'
  | 'overtimeRecords'
  | 'leaveRequests'
  | 'shiftRosters'
  | 'ocrScans'
  | 'shiftClasses'
  | 'rbacRoles'
  | 'productionLines'
  | 'productivityQualityRates'
  | 'userAuditLogs'
  | 'profiles';

const PG_TABLE: Record<StoreKey, string> = {
  employees: 'employees',
  rawAttendanceLogs: 'raw_attendance_logs',
  dailyTimesheets: 'daily_timesheets',
  overtimeRecords: 'overtime_records',
  leaveRequests: 'leave_requests',
  shiftRosters: 'shift_rosters',
  ocrScans: 'ocr_scans',
  shiftClasses: 'shift_classes',
  rbacRoles: 'rbac_roles',
  productionLines: 'production_lines',
  productivityQualityRates: 'productivity_quality_rates',
  userAuditLogs: 'user_audit_logs',
  profiles: 'profiles',
};

const PG_PK: Record<StoreKey, string> = {
  employees: 'employee_id',
  rawAttendanceLogs: 'id',
  dailyTimesheets: 'employee_id_date',
  overtimeRecords: 'employee_id_date',
  leaveRequests: 'id',
  shiftRosters: 'employee_id_date',
  ocrScans: 'id',
  shiftClasses: 'shift_class_id',
  rbacRoles: 'role_id',
  productionLines: 'id',
  productivityQualityRates: 'line_id_date',
  userAuditLogs: 'id',
  profiles: 'id',
};

/** Cột GENERATED ALWAYS không được gửi khi insert/upsert. */
const GENERATED_COLS: Partial<Record<StoreKey, string[]>> = {
  rawAttendanceLogs: ['month', 'year'],
};

/** Field legacy Dexie (shadow Flag 0|1, fts...) — Postgres dùng BOOLEAN thật, luôn loại khi ghi. */
const LEGACY_STRIP = new Set([
  'is_violation_flag', 'is_rest_violation_flag', 'is_shift_mismatch_flag',
  'active_flag', 'is_rotating_flag', 'is_system_flag', 'fts',
]);

export const snakeToCamel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const camelToSnake = (k: string) => k.replace(/([A-Z])/g, (c) => `_${c.toLowerCase()}`);

export function convertRowToCamel(row: any): any {
  if (!row || typeof row !== 'object') return row;
  const out: any = {};
  for (const [k, v] of Object.entries(row)) {
    let val = v;
    // TIME 'HH:mm:ss' → 'HH:mm' (khớp format checkIn/checkOut/startTime cũ)
    if (typeof val === 'string' && /^\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(val)) {
      val = val.slice(0, 5);
    }
    out[snakeToCamel(k)] = val;
    // user_audit_logs dùng created_at làm thời gian ghi → alias timestamp cho UI cũ
    if (k === 'created_at' && typeof val === 'string') out.timestamp = val;
  }
  return out;
}

/** Shallow: chỉ đổi keys tầng 1, object JSONB bên trong giữ nguyên. */
function convertToSnakeShallow(record: any, store: StoreKey): any {
  const stripped = new Set(GENERATED_COLS[store] ?? []);
  const out: any = {};
  for (const [k, v] of Object.entries(record ?? {})) {
    // Bỏ metadata nội bộ _sync/_syncNS/_syncCL của luồng JSON-merge cũ
    if (k.startsWith('_')) continue;
    const sk = camelToSnake(k);
    if (stripped.has(sk) || stripped.has(k)) continue;
    if (LEGACY_STRIP.has(sk)) continue;
    // undefined → null để Supabase xóa giá trị cũ (VD tắt chế độ công tác);
    // field không có trong object thì không gửi gì cả.
    out[sk] = v === undefined ? null : v;
  }
  return out;
}

function throwIfError(res: { error: any }, op: string, store: StoreKey) {
  if (res.error) {
    throw new Error(`[Supabase:${op}:${PG_TABLE[store]}] ${res.error.message || res.error}`);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listAll<T = any>(store: StoreKey): Promise<T[]> {
  const res = await supabase.from(PG_TABLE[store]).select('*').limit(50000);
  throwIfError(res, 'select', store);
  return ((res.data ?? []) as any[]).map(convertRowToCamel) as T[];
}

export interface LiveOpts {
  orderBy?: string;
  ascending?: boolean;
  limit?: number;
}

export async function listOrdered<T = any>(store: StoreKey, opts: LiveOpts): Promise<T[]> {
  let q = supabase.from(PG_TABLE[store]).select('*');
  if (opts.orderBy) q = q.order(camelToSnake(opts.orderBy), { ascending: opts.ascending ?? true });
  if (opts.limit) q = q.limit(opts.limit);
  const res = await q;
  throwIfError(res, 'select', store);
  return ((res.data ?? []) as any[]).map(convertRowToCamel) as T[];
}

export async function getByKey<T = any>(store: StoreKey, key: string | number): Promise<T | null> {
  const res = await supabase.from(PG_TABLE[store]).select('*').eq(PG_PK[store], key).maybeSingle();
  throwIfError(res, 'get', store);
  return res.data ? (convertRowToCamel(res.data) as T) : null;
}

/** Thay db.X.where('field').equals(v).toArray() */
export async function listWhere<T = any>(store: StoreKey, fieldCamel: string, value: any): Promise<T[]> {
  const res = await supabase.from(PG_TABLE[store]).select('*').eq(camelToSnake(fieldCamel), value).limit(50000);
  throwIfError(res, 'where', store);
  return ((res.data ?? []) as any[]).map(convertRowToCamel) as T[];
}

/** Thay db.X.bulkDelete(keys) */
export async function bulkRemove(store: StoreKey, keys: (string | number)[]): Promise<void> {
  if (!keys || keys.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const res = await supabase.from(PG_TABLE[store]).delete().in(PG_PK[store], keys.slice(i, i + CHUNK));
    throwIfError(res, 'bulkRemove', store);
  }
}

/** Thay db.X.where('field').equals(v).delete() */
export async function deleteWhere(store: StoreKey, fieldCamel: string, value: any): Promise<void> {
  const res = await supabase.from(PG_TABLE[store]).delete().eq(camelToSnake(fieldCamel), value);
  throwIfError(res, 'deleteWhere', store);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function upsertOne(store: StoreKey, record: any): Promise<void> {
  const res = await supabase
    .from(PG_TABLE[store])
    .upsert(convertToSnakeShallow(record, store), { onConflict: PG_PK[store] });
  throwIfError(res, 'upsert', store);
}

export async function bulkUpsert(store: StoreKey, records: any[]): Promise<void> {
  if (!records || records.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records.slice(i, i + CHUNK).map((r) => convertToSnakeShallow(r, store));
    const res = await supabase.from(PG_TABLE[store]).upsert(chunk, { onConflict: PG_PK[store] });
    throwIfError(res, 'bulkUpsert', store);
  }
}

export async function updateByKey(store: StoreKey, key: string | number, patch: any): Promise<void> {
  const res = await supabase
    .from(PG_TABLE[store])
    .update(convertToSnakeShallow(patch, store))
    .eq(PG_PK[store], key);
  throwIfError(res, 'update', store);
}

export async function removeByKey(store: StoreKey, key: string | number): Promise<void> {
  const res = await supabase.from(PG_TABLE[store]).delete().eq(PG_PK[store], key);
  throwIfError(res, 'delete', store);
}

/** Xóa toàn bảng (thay db.X.clear() — RLS giới hạn HR roles). */
export async function clearTable(store: StoreKey): Promise<void> {
  const res = await supabase.from(PG_TABLE[store]).delete().not(PG_PK[store], 'is', null);
  throwIfError(res, 'clear', store);
}

// ---------------------------------------------------------------------------
// app_settings (thay db.settings)
// ---------------------------------------------------------------------------

export async function getSetting<T = any>(key: string): Promise<T | null> {
  const res = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
  if (res.error) throw new Error(`[Supabase:settings:get] ${res.error.message}`);
  return (res.data?.value ?? null) as T | null;
}

export async function putSetting(key: string, value: any): Promise<void> {
  const res = await supabase.from('app_settings').upsert({ key, value }, { onConflict: 'key' });
  if (res.error) throw new Error(`[Supabase:settings:put] ${res.error.message}`);
}

// ---------------------------------------------------------------------------
// useLiveTable — thay useLiveQuery(() => db.X.toArray())
// ---------------------------------------------------------------------------

const tableChannels = new Map<string, any>();

function ensureTableChannel(pgTable: string, onChange: () => void) {
  let ch = tableChannels.get(pgTable);
  if (!ch) {
    ch = supabase
      .channel(`tbl:${pgTable}`)
      .on('postgres_changes' as never, { event: '*', schema: 'public', table: pgTable } as never, onChange as never)
      .subscribe();
    tableChannels.set(pgTable, ch);
  }
  return ch;
}

let debounceTimer: any = null;

export function useLiveTable<T = any>(store: StoreKey, opts?: LiveOpts): T[] {
  const [rows, setRows] = useState<T[]>([]);
  const orderKey = opts ? `${opts.orderBy ?? ''}|${opts.ascending ?? ''}|${opts.limit ?? ''}` : '';

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const data = opts ? await listOrdered<T>(store, opts) : await listAll<T>(store);
        if (alive) setRows(data);
      } catch (err) {
        console.warn(`[useLiveTable:${store}]`, err);
      }
    };
    void load();
    const onChange = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void load(), 300);
    };
    ensureTableChannel(PG_TABLE[store], onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, orderKey]);

  return rows;
}
