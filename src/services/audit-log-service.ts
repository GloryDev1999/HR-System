import { IUserAuditLog, AuditActionType, RoleType } from '../types';
import { supabase } from '../lib/supabaseClient';
import { convertRowToCamel } from '../lib/tables';

export interface LogActionParams {
  username: string;
  displayName: string;
  role: RoleType;
  actionType: AuditActionType;
  targetEntity: string;
  details: string;
}

/**
 * Ghi nhận một giao dịch / hoạt động của người dùng vào Supabase user_audit_logs
 */
export async function logUserAction(params: LogActionParams): Promise<IUserAuditLog> {
  const timestamp = new Date().toISOString();

  const entry: IUserAuditLog = {
    id: `LOG_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    timestamp,
    username: params.username,
    displayName: params.displayName,
    role: params.role,
    actionType: params.actionType,
    targetEntity: params.targetEntity,
    details: params.details
  };

  try {
    const { error } = await supabase.from('user_audit_logs').insert({
      id: entry.id,
      username: entry.username,
      display_name: entry.displayName,
      role: entry.role,
      action_type: entry.actionType,
      target_entity: entry.targetEntity,
      details: entry.details,
    });
    if (error) throw error;
  } catch (err) {
    console.error('Failed to write user audit log:', err);
  }

  return entry;
}

/**
 * Lấy danh sách audit logs với bộ lọc tùy chọn
 */
export async function getAuditLogs(options?: {
  username?: string;
  actionType?: AuditActionType;
  limit?: number;
}): Promise<IUserAuditLog[]> {
  try {
    let q = supabase.from('user_audit_logs').select('*').order('created_at', { ascending: false });

    if (options?.username && options.username !== 'ALL') {
      q = q.eq('username', options.username);
    }
    if (options?.actionType && (options.actionType as string) !== 'ALL') {
      q = q.eq('action_type', options.actionType);
    }
    if (options?.limit && options.limit > 0) {
      q = q.limit(options.limit);
    } else {
      q = q.limit(500);
    }

    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as any[]).map((r) => {
      const c = convertRowToCamel(r);
      // bảng dùng created_at làm thời gian ghi; map về timestamp cho UI cũ
      if (!c.timestamp && r.created_at) c.timestamp = r.created_at;
      return c as IUserAuditLog;
    });
  } catch (err) {
    console.error('Failed to query audit logs:', err);
    return [];
  }
}
