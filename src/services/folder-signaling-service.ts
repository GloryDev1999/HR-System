/**
 * Folder Signaling Service (HR_Signaling_Data)
 * Hỗ trợ trao đổi tín hiệu WebRTC P2P Offline qua thư mục OneDrive chia sẻ
 * Sử dụng File System Access API chuẩn trên Microsoft Edge
 * Không mở Port OS, không chạy .exe, hoàn toàn tương thích CrowdStrike Falcon EDR
 */

export interface ISignalFilePayload {
  type: 'CLIENT_HELLO' | 'OFFER_SDP' | 'ANSWER_SDP' | 'HOST_ANNOUNCE';
  clientId?: string;
  clientName?: string;
  targetClient?: string;
  fromHost?: string;
  offer?: string;
  answer?: string;
  timestamp: number;
}

const DB_NAME = 'smarthr_fs_signaling_db';
const STORE_NAME = 'directory_handles';
const HANDLE_KEY = 'hr_signaling_dir';

function openHandlesDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported'));
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class FolderSignalingService {
  private dirHandle: FileSystemDirectoryHandle | null = null;
  private permissionGranted = false;
  private pollTimer: any = null;
  private hostHeartbeatTimer: any = null;
  private messageListener: ((signal: ISignalFilePayload) => void) | null = null;
  private statusListeners: Set<(hasHandle: boolean, folderName: string, isGranted: boolean) => void> = new Set();
  private isPolling = false;
  private lastProcessedTimes = new Map<string, number>();

  constructor() {
    this.restoreHandleFromStorage();
  }

  public isSupported(): boolean {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  public isFileProtocol(): boolean {
    return typeof window !== 'undefined' && (window.location.protocol.startsWith('file:') || window.origin === 'null');
  }

  public hasDirectoryHandle(): boolean {
    return this.dirHandle !== null;
  }

  public isPermissionGranted(): boolean {
    return this.permissionGranted;
  }

  public getFolderName(): string {
    return this.dirHandle ? this.dirHandle.name : '';
  }

  public onStatusChange(fn: (hasHandle: boolean, folderName: string, isGranted: boolean) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.hasDirectoryHandle(), this.getFolderName(), this.isPermissionGranted());
    return () => this.statusListeners.delete(fn);
  }

  private notifyStatus(): void {
    const has = this.hasDirectoryHandle();
    const name = this.getFolderName();
    const granted = this.isPermissionGranted();
    this.statusListeners.forEach(fn => fn(has, name, granted));
  }

  public setMessageListener(fn: (signal: ISignalFilePayload) => void): void {
    this.messageListener = fn;
  }

  /**
   * Khôi phục Directory Handle đã cấp quyền trước đó từ IndexedDB
   */
  public async restoreHandleFromStorage(): Promise<boolean> {
    if (!this.isSupported()) return false;
    try {
      const db = await openHandlesDB();
      const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });

      if (handle) {
        this.dirHandle = handle;
        // Kiểm tra quyền đọc/ghi hiện tại (không kích hoạt prompt nếu chưa click)
        let isGranted = false;
        try {
          if (typeof (handle as any).queryPermission === 'function') {
            const perm = await (handle as any).queryPermission({ mode: 'readwrite' });
            isGranted = (perm === 'granted');
          } else {
            isGranted = true;
          }
        } catch {}
        this.permissionGranted = isGranted;
        this.notifyStatus();
        if (isGranted) {
          this.startPolling();
          return true;
        }
      }
    } catch (err) {
      console.warn('Không thể nạp thư mục signaling từ IndexedDB:', err);
    }
    return false;
  }

  /**
   * Yêu cầu cấp lại quyền đọc/ghi khi người dùng nhấn nút (User Gesture)
   */
  public async requestPermission(): Promise<boolean> {
    if (!this.dirHandle) {
      return this.pickDirectory();
    }
    try {
      const handleAny = this.dirHandle as any;
      if (typeof handleAny.requestPermission === 'function') {
        const perm = await handleAny.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          this.permissionGranted = true;
          this.notifyStatus();
          this.startPolling();
          return true;
        }
      }
    } catch (err) {
      console.warn('Yêu cầu cấp lại quyền thư mục thất bại:', err);
    }
    return this.pickDirectory();
  }

  /**
   * Người dùng bấm nút chọn thư mục HR_Signaling_Data trên OneDrive
   */
  public async pickDirectory(): Promise<boolean> {
    if (!this.isSupported()) {
      throw new Error('Trình duyệt không hỗ trợ chọn thư mục (cần Microsoft Edge hoặc Google Chrome).');
    }

    try {
      const handle = await (window as any).showDirectoryPicker({
        mode: 'readwrite',
        startIn: 'documents'
      });

      if (!handle) return false;

      // Xin cấp quyền đọc ghi
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        throw new Error('Bạn chưa cấp quyền đọc/ghi cho thư mục HR_Signaling_Data.');
      }

      this.dirHandle = handle;
      this.permissionGranted = true;
      this.notifyStatus();

      // Lưu handle vào IndexedDB để dùng lại lần sau
      try {
        const db = await openHandlesDB();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch (e) {
        console.warn('Lưu thư mục vào IndexedDB thất bại:', e);
      }

      this.startPolling();
      return true;
    } catch (err: any) {
      if (err.name === 'AbortError') return false; // Người dùng bấm Hủy
      throw err;
    }
  }

  /**
   * Đảm bảo quyền đọc ghi khi tương tác
   */
  public async ensurePermission(interactive = false): Promise<boolean> {
    if (!this.dirHandle) return false;
    try {
      const handleAny = this.dirHandle as any;
      if (typeof handleAny.queryPermission !== 'function') {
        this.permissionGranted = true;
        return true;
      }
      const perm = await handleAny.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        this.permissionGranted = true;
        return true;
      }
      if (interactive && typeof handleAny.requestPermission === 'function') {
        const req = await handleAny.requestPermission({ mode: 'readwrite' });
        this.permissionGranted = (req === 'granted');
        this.notifyStatus();
        return this.permissionGranted;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Khởi chạy nhịp tim máy Host (Kieu) vào file host_status.json
   * Lặp lại mỗi 3.5 giây để các máy Client biết Host đang hoạt động thực tế
   */
  public startHostHeartbeat(hostInfo: { nodeId: string; displayName?: string }): void {
    this.stopHostHeartbeat();
    const writeBeat = async () => {
      if (!this.dirHandle) return;
      try {
        const payload: ISignalFilePayload = {
          type: 'HOST_ANNOUNCE',
          fromHost: hostInfo.nodeId,
          clientName: hostInfo.displayName || 'Host Master DB',
          timestamp: Date.now()
        };
        await this.writeSignal(payload);
      } catch {}
    };

    writeBeat();
    this.hostHeartbeatTimer = setInterval(writeBeat, 3500);
  }

  public stopHostHeartbeat(): void {
    if (this.hostHeartbeatTimer) {
      clearInterval(this.hostHeartbeatTimer);
      this.hostHeartbeatTimer = null;
    }
  }

  public async markHostOffline(hostNodeId: string): Promise<void> {
    this.stopHostHeartbeat();
    if (!this.dirHandle) return;
    try {
      await this.writeSignal({
        type: 'HOST_ANNOUNCE',
        fromHost: hostNodeId,
        timestamp: 0 // Timestamp 0 biểu thị Host đã tắt
      });
    } catch {}
  }

  /**
   * Kiểm tra trực tiếp xem Host có đang đập nhịp trong HR_Signaling_Data không
   */
  public async checkHostStatus(): Promise<{ online: boolean; hostInfo?: ISignalFilePayload; lastSeen?: number }> {
    if (!this.dirHandle) return { online: false };
    try {
      const fileHandle = await this.dirHandle.getFileHandle('host_status.json');
      const file = await fileHandle.getFile();
      const text = await file.text();
      if (!text.trim()) return { online: false };
      const payload: ISignalFilePayload = JSON.parse(text);
      if (payload && payload.type === 'HOST_ANNOUNCE') {
        const timeDiff = Date.now() - (payload.timestamp || file.lastModified);
        // Nếu nhịp tim mới dưới 15 giây và timestamp > 0 -> Host đang ONLINE
        const isOnline = payload.timestamp > 0 && timeDiff < 15000;
        return {
          online: isOnline,
          hostInfo: payload,
          lastSeen: payload.timestamp || file.lastModified
        };
      }
    } catch {
      // File chưa tồn tại hoặc thư mục chưa cấp quyền
    }
    return { online: false };
  }

  /**
   * Ghi gói tin Signaling thành file JSON trong thư mục HR_Signaling_Data
   */
  public async writeSignal(signal: ISignalFilePayload): Promise<void> {
    if (!this.dirHandle) return;
    const hasPerm = await this.ensurePermission(false);
    if (!hasPerm) return;

    try {
      let filename = '';
      if (signal.type === 'HOST_ANNOUNCE') {
        filename = 'host_status.json';
      } else if (signal.type === 'CLIENT_HELLO' && signal.clientId) {
        filename = `hello_${signal.clientId}.json`;
      } else if (signal.type === 'OFFER_SDP' && signal.targetClient) {
        filename = `offer_${signal.targetClient}.json`;
      } else if (signal.type === 'ANSWER_SDP' && signal.clientId) {
        filename = `answer_${signal.clientId}.json`;
      }

      if (!filename) return;

      const fileHandle = await this.dirHandle.getFileHandle(filename, { create: true });
      const writable = await (fileHandle as any).createWritable();
      await writable.write(JSON.stringify(signal, null, 2));
      await writable.close();
    } catch (err) {
      console.warn('Ghi file signaling thất bại:', err);
    }
  }

  /**
   * Bắt đầu vòng lặp quét thư mục định kỳ 2 giây/lần
   */
  public startPolling(): void {
    if (this.pollTimer || !this.dirHandle) return;

    this.pollTimer = setInterval(async () => {
      if (this.isPolling || !this.dirHandle) return;
      this.isPolling = true;

      try {
        await this.scanDirectoryFiles();
      } catch (err) {
        // Nếu mất quyền, tạm ngưng
      } finally {
        this.isPolling = false;
      }
    }, 2000);
  }

  public stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Quét và phân tích các file JSON trong HR_Signaling_Data
   */
  private async scanDirectoryFiles(): Promise<void> {
    if (!this.dirHandle || !this.permissionGranted) return;

    try {
      for await (const [name, handle] of (this.dirHandle as any).entries()) {
        if (handle.kind !== 'file' || !name.endsWith('.json')) continue;

        try {
          const fileHandle = handle as FileSystemFileHandle;
          const file = await fileHandle.getFile();
          // Bỏ qua file cũ hơn 60 giây (trừ host_status.json được kiểm tra theo timestamp)
          if (name !== 'host_status.json' && Date.now() - file.lastModified > 60000) {
            continue;
          }

          const text = await file.text();
          if (!text.trim()) continue;

          const payload: ISignalFilePayload = JSON.parse(text);
          if (!payload || !payload.type || !this.messageListener) continue;

          const fileTime = payload.timestamp || file.lastModified;
          const prevTime = this.lastProcessedTimes.get(name) || 0;

          if (payload.type === 'HOST_ANNOUNCE') {
            const age = Date.now() - fileTime;
            if (payload.timestamp > 0 && age < 15000) {
              this.messageListener(payload);
            }
          } else {
            // Chỉ kích hoạt xử lý khi file có timestamp mới hơn lần xử lý trước
            if (fileTime > prevTime) {
              this.lastProcessedTimes.set(name, fileTime);
              this.messageListener(payload);
            }
          }
        } catch {
          // File đang được ghi dở từ máy khác (OneDrive sync) -> bỏ qua lần này
        }
      }
    } catch (err) {
      // Kiểm tra xem quyền có bị thu hồi không
      try {
        const perm = await (this.dirHandle as any).queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          this.permissionGranted = false;
          this.notifyStatus();
        }
      } catch {}
    }
  }

  /**
   * Đánh dấu đã tiêu thụ file tín hiệu (KHÔNG XÓA FILE để chống race condition OneDrive)
   */
  public async consumeFile(filename: string): Promise<void> {
    // Tuyệt đối không xóa file JSON khỏi HR_Signaling_Data (OneDrive):
    // Giữ nguyên file giúp người dùng kiểm tra trạng thái và ngăn ngừa xung đột đồng bộ file của OneDrive.
    return Promise.resolve();
  }
}

export const folderSignaling = new FolderSignalingService();
