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
  private pollTimer: any = null;
  private messageListener: ((signal: ISignalFilePayload) => void) | null = null;
  private statusListeners: Set<(hasHandle: boolean, folderName: string) => void> = new Set();
  private isPolling = false;

  constructor() {
    this.restoreHandleFromStorage();
  }

  public isSupported(): boolean {
    return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
  }

  public hasDirectoryHandle(): boolean {
    return this.dirHandle !== null;
  }

  public getFolderName(): string {
    return this.dirHandle ? this.dirHandle.name : '';
  }

  public onStatusChange(fn: (hasHandle: boolean, folderName: string) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.hasDirectoryHandle(), this.getFolderName());
    return () => this.statusListeners.delete(fn);
  }

  private notifyStatus(): void {
    const has = this.hasDirectoryHandle();
    const name = this.getFolderName();
    this.statusListeners.forEach(fn => fn(has, name));
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
        // Kiểm tra quyền đọc/ghi hiện tại
        const perm = typeof (handle as any).queryPermission === 'function'
          ? await (handle as any).queryPermission({ mode: 'readwrite' })
          : 'granted';
        if (perm === 'granted') {
          this.dirHandle = handle;
          this.notifyStatus();
          this.startPolling();
          return true;
        } else {
          // Quyền tạm hoãn cho đến khi có click kích hoạt
          this.dirHandle = handle;
          this.notifyStatus();
        }
      }
    } catch (err) {
      console.warn('Không thể nạp thư mục signaling từ IndexedDB:', err);
    }
    return false;
  }

  /**
   * Người dùng bấm nút chọn thư mục HR_Signaling_Data trên OneDrive
   */
  public async pickDirectory(): Promise<boolean> {
    if (!this.isSupported()) {
      throw new Error('Trình duyệt hiện tại không hỗ trợ File System Access API. Vui lòng sử dụng Microsoft Edge hoặc Google Chrome.');
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
  public async ensurePermission(): Promise<boolean> {
    if (!this.dirHandle) return false;
    try {
      const handleAny = this.dirHandle as any;
      if (typeof handleAny.queryPermission !== 'function') return true;
      const perm = await handleAny.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') return true;
      const req = await handleAny.requestPermission({ mode: 'readwrite' });
      return req === 'granted';
    } catch {
      return false;
    }
  }

  /**
   * Ghi gói tin Signaling thành file JSON trong thư mục HR_Signaling_Data
   */
  public async writeSignal(signal: ISignalFilePayload): Promise<void> {
    if (!this.dirHandle) return;
    const hasPerm = await this.ensurePermission();
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
    if (!this.dirHandle) return;

    try {
      for await (const [name, handle] of (this.dirHandle as any).entries()) {
        if (handle.kind !== 'file' || !name.endsWith('.json')) continue;

        try {
          const fileHandle = handle as FileSystemFileHandle;
          const file = await fileHandle.getFile();
          // Bỏ qua file cũ hơn 2 phút
          if (Date.now() - file.lastModified > 120000) continue;

          const text = await file.text();
          if (!text.trim()) continue;

          const payload: ISignalFilePayload = JSON.parse(text);
          if (payload && payload.type && this.messageListener) {
            this.messageListener(payload);
          }
        } catch {
          // File đang được ghi dở từ máy khác (OneDrive sync) -> bỏ qua lần này
        }
      }
    } catch (err) {
      // Có thể thư mục đang bận hoặc cần cấp quyền lại
    }
  }

  /**
   * Xóa file tín hiệu sau khi đã tiêu thụ xong để tránh xử lý lặp lại
   */
  public async consumeFile(filename: string): Promise<void> {
    if (!this.dirHandle) return;
    try {
      await this.dirHandle.removeEntry(filename);
    } catch {}
  }
}

export const folderSignaling = new FolderSignalingService();
