/**
 * SmartHR Enterprise - LAN Realtime Sync & Presence Service
 * Tự động đồng bộ dữ liệu hai chiều & cập nhật trạng thái online giữa các máy trong mạng LAN
 * Hoàn toàn tương thích Falcon EDR (Sử dụng SSE và REST tiêu chuẩn)
 */

import { db } from '../db';
import { SessionUser } from '../types';

export interface LanOnlineUser {
  username: string;
  displayName: string;
  role: string;
  currentTab?: string;
  ip: string;
  deviceLabel?: string;
  lastActive: number;
  color?: string;
}

export interface LanServerHealth {
  status: 'online' | 'offline';
  latencyMs: number;
  port: number;
  lanAddresses: { name: string; address: string }[];
  onlineUsers: LanOnlineUser[];
  totalMutations: number;
  uptime: number;
}

export interface LanMutation {
  table: string;
  action: 'put' | 'delete' | 'bulkPut';
  record?: any;
  key?: any;
  by: string;
  timestamp: number;
  clientMutationId?: string;
}

type PresenceListener = (users: LanOnlineUser[]) => void;
type StatusListener = (isOnline: boolean, latencyMs: number) => void;

class LanSyncService {
  private eventSource: EventSource | null = null;
  private currentSession: SessionUser | null = null;
  private currentTabName: string = 'Bảng điều khiển';
  private heartbeatInterval: any = null;
  private healthCheckInterval: any = null;
  private lastSyncTimestamp: number = 0;
  private isServerOnline: boolean = false;
  private lastLatencyMs: number = 0;

  private presenceListeners: Set<PresenceListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();
  private cachedOnlineUsers: LanOnlineUser[] = [];

  constructor() {
    if (typeof window !== 'undefined') {
      // Tự động kết nối nếu đang mở qua http:// (không phải file://)
      if (window.location.protocol.startsWith('http')) {
        this.initSseConnection();
      }

      // Kiểm tra sức khỏe máy chủ định kỳ mỗi 15s
      this.healthCheckInterval = setInterval(() => {
        this.checkServerHealth();
      }, 15000);
    }
  }

  // Khởi tạo kết nối Server-Sent Events (SSE)
  public initSseConnection() {
    if (typeof window === 'undefined' || !window.location.protocol.startsWith('http') || typeof EventSource === 'undefined') return;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    try {
      const sseUrl = `${window.location.origin}/api/realtime`;
      this.eventSource = new EventSource(sseUrl);

      this.eventSource.onopen = () => {
        this.isServerOnline = true;
        this.notifyStatus(true, this.lastLatencyMs);
        // Kéo bù dữ liệu nếu có
        if (this.lastSyncTimestamp > 0) {
          this.pullCatchUp();
        }
      };

      // Nhận danh sách user online từ server
      this.eventSource.addEventListener('presence', (e: MessageEvent) => {
        try {
          const users: LanOnlineUser[] = JSON.parse(e.data);
          this.cachedOnlineUsers = users;
          this.notifyPresence(users);
        } catch (err) {
          console.warn('[LAN SYNC] Lỗi parse presence SSE', err);
        }
      });

      // Nhận delta mutation từ máy khác trong mạng LAN
      this.eventSource.addEventListener('mutation', async (e: MessageEvent) => {
        try {
          const mutation: LanMutation = JSON.parse(e.data);
          await this.applyRemoteMutation(mutation);
        } catch (err) {
          console.warn('[LAN SYNC] Lỗi apply mutation SSE', err);
        }
      });

      this.eventSource.onerror = () => {
        this.isServerOnline = false;
        this.notifyStatus(false, 0);
      };
    } catch (err) {
      console.warn('[LAN SYNC] Không thể mở kết nối SSE', err);
    }
  }

  // Đăng ký Session người dùng hiện tại
  public setSession(session: SessionUser | null, tabName?: string) {
    if (tabName) this.currentTabName = tabName;
    this.currentSession = session;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (session) {
      this.sendHeartbeat();
      // Gửi heartbeat đều đặn mỗi 10 giây
      this.heartbeatInterval = setInterval(() => {
        this.sendHeartbeat();
      }, 10000);
    }
  }

  // Cập nhật tab làm việc hiện tại
  public updateTab(tabName: string) {
    this.currentTabName = tabName;
    if (this.currentSession) {
      this.sendHeartbeat();
    }
  }

  // Gửi Heartbeat lên server
  private async sendHeartbeat() {
    if (!this.currentSession || typeof window === 'undefined') return;
    if (!window.location.protocol.startsWith('http')) return;

    try {
      await fetch(`${window.location.origin}/api/presence/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: this.currentSession.username,
          displayName: this.currentSession.displayName,
          role: this.currentSession.role,
          currentTab: this.currentTabName
        })
      });
    } catch {
      // Server offline hoặc mạng đứt -> Bỏ qua
    }
  }

  // Áp dụng thay đổi từ máy khác vào Dexie IndexedDB cục bộ
  private async applyRemoteMutation(mutation: LanMutation) {
    // Nếu chính mình vừa gửi thì bỏ qua (tránh lặp)
    if (this.currentSession && mutation.by === this.currentSession.username) {
      return;
    }

    const { table, action, record, key } = mutation;
    this.lastSyncTimestamp = Math.max(this.lastSyncTimestamp, mutation.timestamp || Date.now());

    try {
      const dexieTable = (db as any)[table];
      if (!dexieTable) return;

      if (action === 'put' && record) {
        await dexieTable.put(record);
      } else if (action === 'bulkPut' && Array.isArray(record)) {
        await dexieTable.bulkPut(record);
      } else if (action === 'delete' && key !== undefined) {
        await dexieTable.delete(key);
      }
    } catch (err) {
      console.warn(`[LAN SYNC] Lỗi nạp mutation vào Dexie [${table}]`, err);
    }
  }

  // Phát sóng một thay đổi dữ liệu lên server để đồng bộ sang các máy khác
  public async broadcastMutation(table: string, action: 'put' | 'delete' | 'bulkPut', recordOrKey: any) {
    if (typeof window === 'undefined' || !window.location.protocol.startsWith('http')) return;

    const myUsername = this.currentSession?.username || 'unknown';
    const payload: LanMutation = {
      table,
      action,
      record: action === 'delete' ? undefined : recordOrKey,
      key: action === 'delete' ? recordOrKey : undefined,
      by: myUsername,
      timestamp: Date.now()
    };

    try {
      await fetch(`${window.location.origin}/api/sync/mutate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      console.warn('[LAN SYNC] Không thể gửi mutation lên server', err);
    }
  }

  // Kéo bù dữ liệu khi vừa kết nối lại (Catch-up sync)
  public async pullCatchUp() {
    if (typeof window === 'undefined' || !window.location.protocol.startsWith('http')) return;
    try {
      const res = await fetch(`${window.location.origin}/api/sync/pull?since=${this.lastSyncTimestamp}`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.mutations)) {
        for (const mutation of data.mutations) {
          await this.applyRemoteMutation(mutation);
        }
      }
    } catch (err) {
      console.warn('[LAN SYNC] Lỗi pull catch-up', err);
    }
  }

  // Kiểm tra độ trễ và trạng thái máy chủ
  public async checkServerHealth(): Promise<LanServerHealth | null> {
    if (typeof window === 'undefined' || !window.location.protocol.startsWith('http')) {
      return null;
    }

    const t0 = performance.now();
    try {
      const res = await fetch(`${window.location.origin}/api/health`, { cache: 'no-store' });
      const latencyMs = Math.round(performance.now() - t0);
      this.lastLatencyMs = latencyMs;

      if (res.ok) {
        const json = await res.json();
        this.isServerOnline = true;
        this.notifyStatus(true, latencyMs);

        return {
          status: 'online',
          latencyMs,
          port: json.port,
          lanAddresses: json.lanAddresses || [],
          onlineUsers: json.onlineUsers || [],
          totalMutations: json.totalMutations || 0,
          uptime: json.uptime || 0
        };
      }
    } catch {
      this.isServerOnline = false;
      this.notifyStatus(false, 0);
    }

    return {
      status: 'offline',
      latencyMs: 0,
      port: 4173,
      lanAddresses: [],
      onlineUsers: [],
      totalMutations: 0,
      uptime: 0
    };
  }

  public getCachedOnlineUsers(): LanOnlineUser[] {
    return this.cachedOnlineUsers;
  }

  public getIsServerOnline(): boolean {
    return this.isServerOnline;
  }

  // Subscriptions
  public onPresence(listener: PresenceListener): () => void {
    this.presenceListeners.add(listener);
    if (this.cachedOnlineUsers.length > 0) {
      listener(this.cachedOnlineUsers);
    }
    return () => this.presenceListeners.delete(listener);
  }

  public onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.isServerOnline, this.lastLatencyMs);
    return () => this.statusListeners.delete(listener);
  }

  private notifyPresence(users: LanOnlineUser[]) {
    this.presenceListeners.forEach(fn => fn(users));
  }

  private notifyStatus(online: boolean, latency: number) {
    this.statusListeners.forEach(fn => fn(online, latency));
  }
}

export const lanSyncService = new LanSyncService();
