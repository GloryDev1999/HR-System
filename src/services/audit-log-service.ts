import { db } from '../db';
import { IUserAuditLog, AuditActionType, RoleType } from '../types';

export interface LogActionParams {
  username: string;
  displayName: string;
  role: RoleType;
  actionType: AuditActionType;
  targetEntity: string;
  details: string;
}

/**
 * Ghi nhận một giao dịch / hoạt động của người dùng vào IndexedDB store userAuditLogs
 */
export async function logUserAction(params: LogActionParams): Promise<IUserAuditLog> {
  const id = `LOG_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const timestamp = new Date().toISOString();

  const entry: IUserAuditLog = {
    id,
    timestamp,
    username: params.username,
    displayName: params.displayName,
    role: params.role,
    actionType: params.actionType,
    targetEntity: params.targetEntity,
    details: params.details
  };

  try {
    await db.userAuditLogs.put(entry);
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
    let collection = db.userAuditLogs.toCollection();

    if (options?.username && options.username !== 'ALL') {
      collection = db.userAuditLogs.where('username').equals(options.username);
    } else if (options?.actionType && (options.actionType as string) !== 'ALL') {
      collection = db.userAuditLogs.where('actionType').equals(options.actionType);
    }

    let results = await collection.reverse().sortBy('timestamp');

    if (options?.username && options.username !== 'ALL' && options?.actionType && (options.actionType as string) !== 'ALL') {
      results = results.filter(r => r.actionType === options.actionType);
    }

    if (options?.limit && options.limit > 0) {
      return results.slice(0, options.limit);
    }

    return results;
  } catch (err) {
    console.error('Failed to query audit logs:', err);
    return [];
  }
}
