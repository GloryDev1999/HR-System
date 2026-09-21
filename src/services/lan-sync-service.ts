/**
 * SmartHR — Supabase Realtime Sync & Presence Service
 * Thay thế LAN SSE server.js (đã xóa): presence + mutation broadcast
 * chạy trên Supabase Realtime channels, không còn /api/*, không EventSource.
 *
 * GIỮ NGUYÊN public interface cũ (LanOnlineUser, LanServerHealth, LanMutation,
 * onPresence/onStatus, setSession, updateTab, broadcastMutation, pullCatchUp,
 * checkServerHealth, getCachedOnlineUsers, getIsServerOnline) để mọi call site
 * (presence-service, SettingsPage) không phải sửa.
 */

import { supabase } from '../lib/supabaseClient';
import type { SessionUser } from '../types';

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
type MutationListener = (mutation: LanMutation) => void;

const PRESENCE_CHANNEL = 'smarthr-presence';
const DATA_CHANNEL = 'smarthr-data';

class LanSyncService {
  private presenceChannel: any = null;
  private dataChannel: any = null;
  private currentSession: SessionUser | null = null;
  private currentTabName: string = 'Bảng điều khiển';
  private healthCheckInterval: any = null;
  private isServerOnline: boolean = false;
  private lastLatencyMs: number = 0;

  private presenceListeners: Set<PresenceListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();
  private mutationListeners: Set<MutationListener> = new Set();
  private cachedOnlineUsers: LanOnlineUser[] = [];

  constructor() {
    if (typeof window !== 'undefined') {
      // Kiểm tra sức khỏe Supabase định kỳ mỗi 15s (thay poll /api/health)
      this.healthCheckInterval = setInterval(() => {
        void this.checkServerHealth();
      }, 15000);
    }
  }

  private supabaseConfigured(): boolean {
    const url = (import.meta as any)?.env?.VITE_SUPABASE_URL as string | undefined;
    const anon = (import.meta as any)?.env?.VITE_SUPABASE_ANON_KEY as string | undefined;
    return Boolean(url && anon);
  }

  private ensureChannels() {
    if (typeof window === 'undefined' || !this.supabaseConfigured()) return;
    if (!this.presenceChannel) {
      this.presenceChannel = supabase.channel(PRESENCE_CHANNEL, {
        config: { presence: { key: this.currentSession?.username ?? 'anon' } },
      });
      this.presenceChannel
        .on('presence', { event: 'sync' }, () => this.handlePresenceSync())
        .on('presence', { event: 'join' }, () => this.handlePresenceSync())
        .on('presence', { event: 'leave' }, () => this.handlePresenceSync())
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            this.isServerOnline = true;
            this.notifyStatus(true, this.lastLatencyMs);
            void this.trackSelf();
          } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
            this.isServerOnline = false;
            this.notifyStatus(false, 0);
          }
        });
    }
    if (!this.dataChannel) {
      this.dataChannel = supabase.channel(DATA_CHANNEL);
      this.dataChannel
        .on('broadcast', { event: 'mutation' }, (msg: any) => {
          const mutation = (msg?.payload ?? msg) as LanMutation;
          if (mutation && mutation.table) this.notifyMutation(mutation);
        })
        .subscribe();
    }
  }

  private async trackSelf() {
    if (!this.presenceChannel || !this.currentSession) return;
    try {
      await this.presenceChannel.track({
        username: this.currentSession.username,
        displayName: this.currentSession.displayName,
        role: this.currentSession.role,
        currentTab: this.currentTabName,
        lastActive: Date.now(),
      });
    } catch {
      // Realtime chưa sẵn sàng — bỏ qua, lần track sau sẽ cập nhật
    }
  }

  private handlePresenceSync() {
    try {
      const state = this.presenceChannel?.presenceState?.() ?? {};
      const byUser = new Map<string, LanOnlineUser>();
      for (const metas of Object.values(state) as any[]) {
        for (const m of metas as any[]) {
          if (!m?.username) continue;
          const key = String(m.username).toLowerCase();
          const prev = byUser.get(key);
          const lastActive = Number(m.lastActive) || Date.now();
          if (!prev || lastActive >= prev.lastActive) {
            byUser.set(key, {
              username: m.username,
              displayName: m.displayName || m.username,
              role: m.role || 'User',
              currentTab: m.currentTab || 'Bảng điều khiển',
              ip: '',
              deviceLabel: 'Supabase Realtime',
              lastActive,
              color: m.color || '',
            });
          }
        }
      }
      this.cachedOnlineUsers = Array.from(byUser.values());
      this.notifyPresence(this.cachedOnlineUsers);
    } catch (err) {
      console.warn('[SUPABASE SYNC] Lỗi parse presence', err);
    }
  }

  // Đăng ký Session người dùng hiện tại
  public setSession(session: SessionUser | null, tabName?: string) {
    if (tabName) this.currentTabName = tabName;
    const changed = this.currentSession?.username !== session?.username;
    this.currentSession = session;

    if (session) {
      this.ensureChannels();
      if (changed) void this.trackSelf();
      else void this.trackSelf();
    } else {
      void this.presenceChannel?.untrack?.().catch(() => undefined);
    }
  }

  // Cập nhật tab làm việc hiện tại
  public updateTab(tabName: string) {
    this.currentTabName = tabName;
    if (this.currentSession) void this.trackSelf();
  }

  // Phát sóng một thay đổi dữ liệu cho các máy khác (Supabase broadcast).
  // Data layer mới đọc trực tiếp Postgres + postgres_changes; broadcast này
  // chỉ là tín hiệu phụ để UI refresh lạc quan.
  public async broadcastMutation(table: string, action: 'put' | 'delete' | 'bulkPut', recordOrKey: any) {
    if (typeof window === 'undefined' || !this.supabaseConfigured()) return;
    this.ensureChannels();

    const myUsername = this.currentSession?.username || 'unknown';
    const payload: LanMutation = {
      table,
      action,
      record: action === 'delete' ? undefined : recordOrKey,
      key: action === 'delete' ? recordOrKey : undefined,
      by: myUsername,
      timestamp: Date.now(),
    };

    try {
      await this.dataChannel?.send({ type: 'broadcast', event: 'mutation', payload });
    } catch (err) {
      console.warn('[SUPABASE SYNC] Không thể gửi mutation broadcast', err);
    }
  }

  // Supabase là source-of-truth tập trung → không cần kéo bù journal.
  // Giữ method để tương thích SettingsPage cũ.
  public async pullCatchUp() {
    return;
  }

  // Kiểm tra sức khỏe Supabase bằng chính SDK + query thật (thay /api/health cũ).
  // Dùng đúng đường mà app đang dùng nên kết quả khớp thực tế sử dụng.
  public async checkServerHealth(): Promise<LanServerHealth | null> {
    if (typeof window === 'undefined') return null;

    const offline: LanServerHealth = {
      status: 'offline',
      latencyMs: 0,
      port: 443,
      lanAddresses: [],
      onlineUsers: this.cachedOnlineUsers,
      totalMutations: 0,
      uptime: 0,
    };

    if (!this.supabaseConfigured()) {
      this.isServerOnline = false;
      this.notifyStatus(false, 0);
      return offline;
    }

    const t0 = performance.now();
    try {
      const { error } = await supabase.from('app_settings').select('key').limit(1);
      const latencyMs = Math.round(performance.now() - t0);
      this.lastLatencyMs = latencyMs;
      const online = !error;
      if (error) console.warn('[SUPABASE SYNC] health check:', error.message);
      this.isServerOnline = online;
      this.notifyStatus(online, latencyMs);
      return {
        status: online ? 'online' : 'offline',
        latencyMs,
        port: 443,
        lanAddresses: [],
        onlineUsers: this.cachedOnlineUsers,
        totalMutations: 0,
        uptime: 0,
      };
    } catch (err: any) {
      console.warn('[SUPABASE SYNC] health check exception:', err?.message || err);
      this.isServerOnline = false;
      this.notifyStatus(false, 0);
    }

    return offline;
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
    this.ensureChannels();
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

  /** Mới: lắng nghe mutation broadcast từ máy khác (data layer Supabase dùng). */
  public onMutation(listener: MutationListener): () => void {
    this.mutationListeners.add(listener);
    this.ensureChannels();
    return () => this.mutationListeners.delete(listener);
  }

  private notifyPresence(users: LanOnlineUser[]) {
    this.presenceListeners.forEach((fn) => fn(users));
  }

  private notifyStatus(online: boolean, latency: number) {
    this.statusListeners.forEach((fn) => fn(online, latency));
  }

  private notifyMutation(mutation: LanMutation) {
    // Bỏ qua echo chính mình (tránh lặp) — cùng luật với SSE cũ
    if (this.currentSession && mutation.by === this.currentSession.username) return;
    this.mutationListeners.forEach((fn) => fn(mutation));
  }
}

export const lanSyncService = new LanSyncService();
