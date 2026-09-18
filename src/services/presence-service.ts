import { RoleType, SessionUser } from '../types';
import { lanSyncService } from './lan-sync-service';

export interface ActiveUserPresence {
  username: string;
  displayName: string;
  role: RoleType;
  status: 'online' | 'busy' | 'away';
  lastActive: number; // timestamp ms
  currentTab?: string;
  color?: string;
}

const PRESENCE_STORAGE_KEY = 'smarthr_active_presences_v1';
const CHANNEL_NAME = 'smarthr_presence_channel_v1';
const HEARTBEAT_INTERVAL_MS = 8000;
const OFFLINE_THRESHOLD_MS = 25000;

// Bộ màu avatar đẹp theo design system
const USER_COLORS: Record<string, string> = {
  vinh: 'from-amber-500 to-orange-600',
  kieu: 'from-blue-500 to-indigo-600',
  admin: 'from-slate-700 to-slate-900',
};

function getUserColor(username: string): string {
  const key = username.toLowerCase();
  if (USER_COLORS[key]) return USER_COLORS[key];
  const colors = [
    'from-emerald-500 to-teal-600',
    'from-rose-500 to-pink-600',
    'from-purple-500 to-indigo-600',
    'from-cyan-500 to-blue-600',
  ];
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash += username.charCodeAt(i);
  return colors[hash % colors.length];
}

class PresenceManager {
  private channel: BroadcastChannel | null = null;
  private currentSession: SessionUser | null = null;
  private heartbeatTimer: any = null;
  private checkTimer: any = null;
  private listeners: Set<(users: ActiveUserPresence[]) => void> = new Set();
  private currentTabName: string = 'Bảng điều khiển';

  constructor() {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        this.channel.onmessage = (event) => {
          this.handleChannelMessage(event.data);
        };
      } catch (err) {
        console.warn('BroadcastChannel not available, using localStorage fallback', err);
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === PRESENCE_STORAGE_KEY) {
          this.notifyListeners();
        }
      });

      window.addEventListener('beforeunload', () => {
        this.leave();
      });

      // Bắt đầu dọn dẹp user offline định kỳ
      this.checkTimer = setInterval(() => {
        this.cleanupAndNotify();
      }, 8000);

      // Đăng ký nhận user online qua kênh SSE Realtime mạng LAN
      lanSyncService.onPresence((lanUsers) => {
        for (const u of lanUsers) {
          if (this.currentSession && u.username.toLowerCase() === this.currentSession.username.toLowerCase()) continue;
          this.recordRemotePresence({
            username: u.username,
            displayName: u.displayName,
            role: u.role as any,
            status: 'online',
            lastActive: u.lastActive,
            currentTab: u.currentTab,
            color: getUserColor(u.username)
          });
        }
      });
    }
  }

  public setSession(session: SessionUser | null, tabName?: string) {
    if (tabName) this.currentTabName = tabName;

    lanSyncService.setSession(session, tabName || this.currentTabName);

    if (!session) {
      this.leave();
      this.currentSession = null;
      this.stopHeartbeat();
      return;
    }

    this.currentSession = session;
    this.sendHeartbeat();
    this.startHeartbeat();
  }

  public updateCurrentTab(tabName: string) {
    this.currentTabName = tabName;
    lanSyncService.updateTab(tabName);
    if (this.currentSession) {
      this.sendHeartbeat();
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat() {
    if (!this.currentSession) return;

    const presence: ActiveUserPresence = {
      username: this.currentSession.username,
      displayName: this.currentSession.displayName,
      role: this.currentSession.role,
      status: 'online',
      lastActive: Date.now(),
      currentTab: this.currentTabName,
      color: getUserColor(this.currentSession.username),
    };

    // 1. Cập nhật localStorage
    const all = this.getAllPresences();
    all[presence.username.toLowerCase()] = presence;
    this.savePresences(all);

    // 2. Bắn tin qua BroadcastChannel
    try {
      this.channel?.postMessage({ type: 'HEARTBEAT', payload: presence });
    } catch {}

    this.notifyListeners();
  }

  private leave() {
    if (!this.currentSession) return;
    const usernameKey = this.currentSession.username.toLowerCase();

    const all = this.getAllPresences();
    delete all[usernameKey];
    this.savePresences(all);

    try {
      this.channel?.postMessage({ type: 'LEAVE', payload: { username: this.currentSession.username } });
    } catch {}

    this.notifyListeners();
  }

  private handleChannelMessage(msg: any) {
    if (!msg || !msg.type) return;
    if (msg.type === 'HEARTBEAT' || msg.type === 'LEAVE') {
      this.notifyListeners();
    }
  }

  private getAllPresences(): Record<string, ActiveUserPresence> {
    if (typeof localStorage === 'undefined') return {};
    try {
      const raw = localStorage.getItem(PRESENCE_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  private savePresences(all: Record<string, ActiveUserPresence>) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(PRESENCE_STORAGE_KEY, JSON.stringify(all));
    } catch {}
  }

  private cleanupAndNotify() {
    const all = this.getAllPresences();
    const now = Date.now();
    let changed = false;

    for (const [key, user] of Object.entries(all)) {
      // Nếu user hiện tại đang giữ session này thì không xoá
      if (this.currentSession && this.currentSession.username.toLowerCase() === key) continue;

      if (now - user.lastActive > OFFLINE_THRESHOLD_MS) {
        delete all[key];
        changed = true;
      }
    }

    if (changed) {
      // Đọc lại fresh từ localStorage để hòa trộn, bảo vệ các presence mới mà tab khác vừa cập nhật
      const fresh = this.getAllPresences();
      for (const [key, user] of Object.entries(all)) {
        if (fresh[key] && fresh[key].lastActive > user.lastActive) {
          all[key] = fresh[key];
        }
      }
      // Giữ lại các user mới mà fresh có nhưng all chưa kịp có
      for (const [key, user] of Object.entries(fresh)) {
        if (!all[key] && now - user.lastActive <= OFFLINE_THRESHOLD_MS) {
          all[key] = user;
        }
      }
      this.savePresences(all);
    }
    this.notifyListeners();
  }

  public getActiveUsers(): ActiveUserPresence[] {
    const all = this.getAllPresences();
    const now = Date.now();
    const activeList = Object.values(all).filter((u) => {
      if (this.currentSession && this.currentSession.username.toLowerCase() === u.username.toLowerCase()) {
        return true;
      }
      return now - u.lastActive <= OFFLINE_THRESHOLD_MS;
    });

    return activeList.sort((a, b) => {
      if (this.currentSession?.username.toLowerCase() === a.username.toLowerCase()) return -1;
      if (this.currentSession?.username.toLowerCase() === b.username.toLowerCase()) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }

  public subscribe(listener: (users: ActiveUserPresence[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.getActiveUsers());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public recordRemotePresence(presence: ActiveUserPresence): void {
    if (!presence?.username) return;
    const all = this.getAllPresences();
    const key = presence.username.toLowerCase();
    const existing = all[key];
    const newActive = presence.lastActive || Date.now();
    if (!existing || newActive >= existing.lastActive) {
      all[key] = {
        ...presence,
        lastActive: newActive
      };
      this.savePresences(all);
    }
    this.notifyListeners();
  }

  public recordRemoteLeave(username: string): void {
    if (!username) return;
    const all = this.getAllPresences();
    delete all[username.toLowerCase()];
    this.savePresences(all);
    this.notifyListeners();
  }

  public getCurrentPresence(): ActiveUserPresence | null {
    if (!this.currentSession) return null;
    return {
      username: this.currentSession.username,
      displayName: this.currentSession.displayName,
      role: this.currentSession.role,
      status: 'online',
      lastActive: Date.now(),
      currentTab: this.currentTabName,
      color: getUserColor(this.currentSession.username)
    };
  }

  private notifyListeners() {
    const users = this.getActiveUsers();
    this.listeners.forEach((fn) => fn(users));
  }
}

export const presenceManager = new PresenceManager();
