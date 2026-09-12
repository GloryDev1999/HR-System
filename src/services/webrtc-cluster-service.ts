/**
 * WebRTC P2P Cluster Service — Star Topology (1 Host - 5 Clients via RTCDataChannel)
 * Đáp ứng kiến trúc Local-First In-Browser:
 * - 100% In-Browser trên Microsoft Edge
 * - Không spawn tiến trình .exe, không mở port OS (vượt CrowdStrike Falcon EDR)
 * - Đa kênh tín hiệu (Multi-Transport Signaling Bus):
 *     1. HTTP Relay qua cổng 3000 hiện có (/api/cluster/signaling) khi chạy mạng LAN
 *     2. BroadcastChannel & Storage Event Bus tức thời giữa các tab trên cùng máy
 *     3. Ghép nối Offline bằng Token thủ công / thư mục HR_Signaling_Data khi mở file://
 * - Vanilla ICE Gathering: Chờ thu thập ứng viên IP LAN trước khi xuất SDP, chống treo vô tận
 * - Đồng bộ danh sách online users và sơ đồ 6 máy trong cụm (Star-Topology) thời gian thực
 */

import { IClusterConfig, IClusterNode, IClusterMessage, DEFAULT_CLUSTER_CONFIG, NodeRole, NodeConnectionStatus } from '../types/cluster';
import { db } from '../db';
import { logUserAction } from './audit-log-service';
import { presenceManager } from './presence-service';
import { folderSignaling } from './folder-signaling-service';

type MessageHandler = (msg: IClusterMessage) => void;
type StatusChangeHandler = (status: NodeConnectionStatus, details?: string) => void;

interface ISignalEnvelope {
  type: 'CLIENT_HELLO' | 'OFFER_SDP' | 'ANSWER_SDP' | 'HOST_ANNOUNCE';
  clientId?: string;
  clientName?: string;
  targetClient?: string;
  fromHost?: string;
  offer?: string;
  answer?: string;
  timestamp: number;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

class WebRTCClusterService {
  private config: IClusterConfig = { ...DEFAULT_CLUSTER_CONFIG };
  private peerConnections = new Map<string, RTCPeerConnection>();
  private dataChannels = new Map<string, RTCDataChannel>();
  private messageListeners = new Set<MessageHandler>();
  private statusListeners = new Set<StatusChangeHandler>();
  private currentStatus: NodeConnectionStatus = 'IDLE';

  private signalingChannel: BroadcastChannel | null = null;
  private connectTimeoutTimer: any = null;
  private heartbeatTimer: any = null;
  private httpPollTimer: any = null;
  private lastSignalSince: number = 0;

  constructor() {
    this.loadConfig();
    this.setupSignalingBus();
  }

  private setupSignalingBus(): void {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        this.signalingChannel = new BroadcastChannel('smarthr_p2p_signaling_bus');
        this.signalingChannel.onmessage = (e) => {
          this.handleSignalingMessage(e.data);
        };
      } catch (err) {
        console.warn('Signaling BroadcastChannel unavailable:', err);
      }
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (e) => {
        if (e.key === 'smarthr_p2p_signaling_event' && e.newValue) {
          try {
            const data: ISignalEnvelope = JSON.parse(e.newValue);
            this.handleSignalingMessage(data);
          } catch {}
        }
      });

      // Kích hoạt HTTP Polling nếu đang truy cập qua Web Server (http / https)
      if (window.location.protocol.startsWith('http')) {
        this.startHttpSignalingPoll();
      }

      // Kích hoạt nhận tín hiệu file từ thư mục HR_Signaling_Data (OneDrive)
      folderSignaling.setMessageListener((signal) => {
        this.handleSignalingMessage(signal);
      });
    }
  }

  private startHttpSignalingPoll(): void {
    if (this.httpPollTimer) return;
    this.httpPollTimer = setInterval(async () => {
      try {
        // Chỉ poll khi ở trạng thái SIGNALING, CONNECTED hoặc là Host đã cấu hình
        if (this.currentStatus === 'IDLE' && !this.isHostConfigured()) return;

        const params = new URLSearchParams({
          role: this.config.nodeRole,
          nodeId: this.config.nodeId,
          since: String(this.lastSignalSince)
        });

        const res = await fetch(`/api/cluster/signaling?${params.toString()}`);
        if (!res.ok) return;
        const data = await res.json();

        if (Array.isArray(data.signals) && data.signals.length > 0) {
          for (const sig of data.signals) {
            if (sig.arrivedAt && sig.arrivedAt > this.lastSignalSince) {
              this.lastSignalSince = sig.arrivedAt;
            }
            await this.handleSignalingMessage(sig);
          }
        }
        if (data.timestamp && data.timestamp > this.lastSignalSince) {
          this.lastSignalSince = Math.max(this.lastSignalSince, data.timestamp - 1000);
        }
      } catch {
        // Môi trường không có API server (offline / mock) - bỏ qua an toàn
      }
    }, 1200);
  }

  private emitSignal(signal: ISignalEnvelope): void {
    try {
      this.signalingChannel?.postMessage(signal);
    } catch {}
    try {
      localStorage.setItem('smarthr_p2p_signaling_event', JSON.stringify({ ...signal, _rnd: Math.random() }));
    } catch {}

    // Chuyển tiếp tín hiệu qua HTTP Relay endpoint nếu đang chạy web
    if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
      fetch('/api/cluster/signaling', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signal)
      }).catch(() => {});
    }

    // Ghi file JSON vào thư mục chia sẻ OneDrive (HR_Signaling_Data)
    folderSignaling.writeSignal(signal).catch(() => {});
  }

  private async handleSignalingMessage(signal: ISignalEnvelope): Promise<void> {
    if (!signal || !signal.type) return;

    // 1. Host nhận tín hiệu chào hỏi từ máy Client
    if (this.config.nodeRole === 'HOST' && signal.type === 'CLIENT_HELLO') {
      const clientId = signal.clientId;
      if (!clientId || clientId === this.config.nodeId) return;

      // Tiêu thụ file hello
      folderSignaling.consumeFile(`hello_${clientId}.json`).catch(() => {});

      try {
        const offerJson = await this.createOfferForClient(clientId);
        this.emitSignal({
          type: 'OFFER_SDP',
          targetClient: clientId,
          fromHost: this.config.nodeId,
          offer: offerJson,
          timestamp: Date.now()
        });
      } catch (err) {
        console.error(`Host tạo Offer cho Client ${clientId} thất bại:`, err);
      }
    }

    // 2. Client nhận gói Offer SDP từ Host
    if (this.config.nodeRole === 'CLIENT' && signal.type === 'OFFER_SDP') {
      if (signal.targetClient === this.config.nodeId && signal.offer) {
        // Tiêu thụ file offer
        folderSignaling.consumeFile(`offer_${this.config.nodeId}.json`).catch(() => {});

        try {
          const answerJson = await this.receiveOfferAndCreateAnswer(signal.offer);
          this.emitSignal({
            type: 'ANSWER_SDP',
            clientId: this.config.nodeId,
            fromHost: signal.fromHost,
            answer: answerJson,
            timestamp: Date.now()
          });
        } catch (err) {
          console.error('Client xử lý Offer & tạo Answer thất bại:', err);
        }
      }
    }

    // 3. Host nhận gói Answer SDP từ Client để chốt bắt tay
    if (this.config.nodeRole === 'HOST' && signal.type === 'ANSWER_SDP') {
      const clientId = signal.clientId;
      if (clientId && signal.answer) {
        // Tiêu thụ file answer
        folderSignaling.consumeFile(`answer_${clientId}.json`).catch(() => {});

        try {
          await this.receiveAnswer(clientId, signal.answer);
        } catch (err) {
          console.error(`Host nạp Answer từ ${clientId} thất bại:`, err);
        }
      }
    }

    // 4. Client phát hiện Host vừa Online
    if (this.config.nodeRole === 'CLIENT' && signal.type === 'HOST_ANNOUNCE') {
      if (this.currentStatus === 'HOST_OFFLINE' || this.currentStatus === 'IDLE' || this.isAutoConnectClient()) {
        this.initClientMode();
      }
    }
  }

  public loadConfig(): IClusterConfig {
    const saved = localStorage.getItem('smarthr_cluster_config');
    if (saved) {
      try {
        this.config = { ...DEFAULT_CLUSTER_CONFIG, ...JSON.parse(saved) };
      } catch {
        this.config = { ...DEFAULT_CLUSTER_CONFIG };
      }
    }
    return this.config;
  }

  public saveConfig(newConfig: Partial<IClusterConfig>): void {
    this.config = { ...this.config, ...newConfig };
    localStorage.setItem('smarthr_cluster_config', JSON.stringify(this.config));
  }

  public getConfig(): IClusterConfig {
    return { ...this.config };
  }

  public getStatus(): NodeConnectionStatus {
    return this.currentStatus;
  }

  public setStatus(status: NodeConnectionStatus, details?: string): void {
    this.currentStatus = status;
    this.statusListeners.forEach(fn => fn(status, details));
  }

  public onStatusChange(callback: StatusChangeHandler): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  public onMessage(callback: MessageHandler): () => void {
    this.messageListeners.add(callback);
    return () => this.messageListeners.delete(callback);
  }

  /**
   * Khởi tạo máy tính với vai trò Host (Kieu) hoặc Client (Vinh, Nguyet Anh, Han, Hoa, Glory)
   */
  public async initializeNode(role: NodeRole, nodeId: string, displayName: string): Promise<void> {
    this.saveConfig({ nodeRole: role, nodeId, displayName });
    this.setStatus('SIGNALING', `Đã kích hoạt chế độ ${role === 'HOST' ? 'Máy Chủ Host (Master DB)' : 'Máy Trạm Client'}`);

    if (role === 'HOST') {
      this.initHostMode();
    } else {
      this.initClientMode();
    }
  }

  /**
   * Kieu (hoặc máy Host) chỉ cần bấm Host 1 lần duy nhất:
   * Hệ thống ghi nhớ cấu hình và tự động kích hoạt mỗi lần mở ứng dụng.
   */
  public async quickStartAsHost(nodeId = 'HOST_KIEU_01', displayName = 'Kieu(Mia) - System Admin Master DB'): Promise<void> {
    localStorage.setItem('smarthr_is_host', 'true');
    localStorage.removeItem('smarthr_auto_connect_client');
    await this.initializeNode('HOST', nodeId, displayName);
  }

  /**
   * Nút Kết Nối 1-Chạm (1-Touch Connect) dành cho máy Client (Vinh, Nguyet Anh, Han, Hoa, Glory):
   * Tự động nhận diện tài khoản đang đăng nhập, lấy đúng ID node và kết nối tức thời.
   */
  public async quickConnectAsClient(username: string, userDisplayName?: string): Promise<void> {
    const nodeMap: Record<string, { id: string; name: string }> = {
      vinh: { id: 'CLIENT_01', name: 'Vinh(Glory) - Kho WH' },
      nguyetanh: { id: 'CLIENT_02', name: 'Nguyet Anh - QC' },
      han: { id: 'CLIENT_03', name: 'Han - Sản Xuất' },
      hoa: { id: 'CLIENT_04', name: 'Hoa(Molly) - HR' },
      glory: { id: 'CLIENT_05', name: 'Glory(Software) - Kỹ Thuật' }
    };

    const targetNode = nodeMap[username.toLowerCase()] || {
      id: `CLIENT_${username.toUpperCase()}`,
      name: userDisplayName || username
    };

    localStorage.setItem('smarthr_auto_connect_client', 'true');
    localStorage.removeItem('smarthr_is_host');
    await this.initializeNode('CLIENT', targetNode.id, targetNode.name);
  }

  public isHostConfigured(): boolean {
    return localStorage.getItem('smarthr_is_host') === 'true';
  }

  public isAutoConnectClient(): boolean {
    return localStorage.getItem('smarthr_auto_connect_client') === 'true';
  }

  private initHostMode(): void {
    this.setStatus('SIGNALING', 'Host Master DB đang sẵn sàng tiếp nhận kết nối RTCDataChannel');
    this.emitSignal({
      type: 'HOST_ANNOUNCE',
      fromHost: this.config.nodeId,
      timestamp: Date.now()
    });
    this.startClusterHeartbeat();
  }

  private initClientMode(): void {
    this.setStatus('SIGNALING', 'Client đang tìm kiếm Host Kiều trong mạng...');

    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
    }

    // Phát tín hiệu tìm kiếm Host
    this.emitSignal({
      type: 'CLIENT_HELLO',
      clientId: this.config.nodeId,
      clientName: this.config.displayName,
      timestamp: Date.now()
    });

    // MỐC XÁC ĐỊNH KẾT NỐI (TIMEOUT 10 GIÂY):
    // Đảm bảo đủ thời gian gom ICE Candidate và chuyển tiếp tín hiệu LAN
    this.connectTimeoutTimer = setTimeout(() => {
      if (this.currentStatus === 'SIGNALING') {
        this.setStatus('HOST_OFFLINE', 'Host Kiều chưa online hoặc chưa khởi chạy. Hệ thống đang hoạt động ở chế độ Cục Bộ (Local-First).');
      }
    }, 10000);
  }

  /**
   * Vanilla ICE Gathering Helper:
   * Chờ RTCPeerConnection thu thập đầy đủ địa chỉ IP LAN (host candidates)
   * trước khi chuyển tiếp SDP, chống lỗi kết nối vô vọng do thiếu IP ứng viên.
   */
  private waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
    if (pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          pc.removeEventListener('icecandidate', onCandidate);
          pc.removeEventListener('icegatheringstatechange', onStateChange);
          resolve();
        }
      };

      const timer = setTimeout(finish, timeoutMs);

      const onCandidate = (e: RTCPeerConnectionIceEvent) => {
        // Candidate null báo hiệu quá trình gom ICE kết thúc
        if (!e.candidate) {
          finish();
        }
      };

      const onStateChange = () => {
        if (pc.iceGatheringState === 'complete') {
          finish();
        }
      };

      pc.addEventListener('icecandidate', onCandidate);
      pc.addEventListener('icegatheringstatechange', onStateChange);
    });
  }

  /**
   * Tạo gói tin Offer SDP để trao đổi file Signaling
   */
  public async createOfferForClient(clientId: string): Promise<string> {
    const oldPc = this.peerConnections.get(clientId);
    if (oldPc) {
      try { oldPc.close(); } catch {}
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peerConnections.set(clientId, pc);

    const dc = pc.createDataChannel('smarthr-cluster-channel', {
      ordered: true
    });
    this.setupDataChannel(clientId, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Bắt buộc chờ gom ứng viên ICE để SDP chứa IP LAN
    await this.waitForIceGathering(pc, 2000);

    return JSON.stringify({
      type: 'OFFER',
      fromHost: this.config.nodeId,
      targetClient: clientId,
      sdp: pc.localDescription,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Client nhận Offer từ Host và tạo Answer SDP
   */
  public async receiveOfferAndCreateAnswer(offerJson: string): Promise<string> {
    const offerData = JSON.parse(offerJson);
    const oldPc = this.peerConnections.get('HOST');
    if (oldPc) {
      try { oldPc.close(); } catch {}
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peerConnections.set('HOST', pc);

    pc.ondatachannel = (e) => {
      this.setupDataChannel('HOST', e.channel);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offerData.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Bắt buộc chờ gom ứng viên ICE
    await this.waitForIceGathering(pc, 2000);

    return JSON.stringify({
      type: 'ANSWER',
      fromClient: this.config.nodeId,
      sdp: pc.localDescription,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Host nhận Answer từ Client để hoàn tất bắt tay (Handshake)
   */
  public async receiveAnswer(clientId: string, answerJson: string): Promise<void> {
    const answerData = JSON.parse(answerJson);
    const pc = this.peerConnections.get(clientId);
    if (!pc) throw new Error(`Không tìm thấy phiên kết nối cho client ${clientId}`);

    await pc.setRemoteDescription(new RTCSessionDescription(answerData.sdp));
  }

  private setupDataChannel(remoteNodeId: string, channel: RTCDataChannel): void {
    this.dataChannels.set(remoteNodeId, channel);

    channel.onopen = () => {
      if (this.connectTimeoutTimer) {
        clearTimeout(this.connectTimeoutTimer);
        this.connectTimeoutTimer = null;
      }

      this.setStatus('CONNECTED', `RTCDataChannel với ${remoteNodeId} đã mở`);
      this.updateNodeStatus(remoteNodeId, 'CONNECTED');

      // Gửi gói Handshake
      this.sendMessage(remoteNodeId, {
        id: `msg_${Date.now()}`,
        type: 'HANDSHAKE',
        senderId: this.config.nodeId,
        senderName: this.config.displayName,
        timestamp: new Date().toISOString()
      });

      // Nếu là Host: phân phối danh sách Node cập nhật cho Client vừa vào
      if (this.config.nodeRole === 'HOST') {
        this.sendMessage(remoteNodeId, {
          id: `nodes_${Date.now()}`,
          type: 'NODES_UPDATE',
          senderId: this.config.nodeId,
          senderName: this.config.displayName,
          timestamp: new Date().toISOString(),
          payload: { nodes: this.config.nodes }
        });
      }

      this.startClusterHeartbeat();
    };

    channel.onclose = () => {
      this.updateNodeStatus(remoteNodeId, 'DISCONNECTED');
      this.dataChannels.delete(remoteNodeId);
      this.peerConnections.delete(remoteNodeId);

      if (this.config.nodeRole === 'CLIENT') {
        this.setStatus('DISCONNECTED', 'Đã ngắt kết nối với Host Kiều');
        // Tự động kết nối lại sau 4s nếu ở chế độ auto-connect
        setTimeout(() => {
          if (this.isAutoConnectClient() && this.currentStatus !== 'CONNECTED') {
            this.initClientMode();
          }
        }, 4000);
      } else {
        this.broadcastNodesUpdate();
        if (this.dataChannels.size === 0) {
          this.setStatus('SIGNALING', 'Host Master DB đang chờ các client kết nối');
        }
      }
    };

    channel.onmessage = (event) => {
      try {
        const msg: IClusterMessage = JSON.parse(event.data);
        this.handleIncomingMessage(remoteNodeId, msg);
      } catch (err) {
        console.error('Lỗi phân tích tin nhắn WebRTC:', err);
      }
    };
  }

  private handleIncomingMessage(senderNodeId: string, msg: IClusterMessage): void {
    this.messageListeners.forEach(fn => fn(msg));

    // Xử lý Handshake & Handshake ACK
    if (msg.type === 'HANDSHAKE') {
      this.updateNodeStatus(senderNodeId, 'CONNECTED');
      if (this.config.nodeRole === 'HOST') {
        this.sendMessage(senderNodeId, {
          id: `ack_${Date.now()}`,
          type: 'HANDSHAKE_ACK',
          senderId: this.config.nodeId,
          senderName: this.config.displayName,
          timestamp: new Date().toISOString()
        });
        this.broadcastNodesUpdate();
      }
    } else if (msg.type === 'HANDSHAKE_ACK') {
      this.setStatus('CONNECTED', 'Đã kết nối thành công với Host Kiều');
      this.updateNodeStatus('HOST', 'CONNECTED');
    }

    // Nhận cập nhật trạng thái Sơ đồ mạng từ Host
    if (msg.type === 'NODES_UPDATE' && msg.payload?.nodes) {
      this.config.nodes = msg.payload.nodes;
      this.saveConfig({ nodes: msg.payload.nodes });
      this.statusListeners.forEach(fn => fn(this.currentStatus));
    }

    // Đồng bộ Realtime Presence qua WebRTC DataChannel
    if (msg.type === 'PRESENCE_HEARTBEAT' && msg.payload) {
      presenceManager.recordRemotePresence(msg.payload);
      // Nếu là Host: phân phối cho các client khác trong cụm
      if (this.config.nodeRole === 'HOST') {
        this.dataChannels.forEach((ch, targetId) => {
          if (targetId !== senderNodeId && ch.readyState === 'open') {
            ch.send(JSON.stringify(msg));
          }
        });
      }
    }

    // Nếu là Host: xử lý Action nghiệp vụ gửi từ Client và ghi vào Master DB
    if (this.config.nodeRole === 'HOST' && msg.type === 'ACTION') {
      this.processClientActionAtHost(senderNodeId, msg);
    }
  }

  private broadcastNodesUpdate(): void {
    if (this.config.nodeRole !== 'HOST') return;
    const msg: IClusterMessage = {
      id: `nodes_${Date.now()}`,
      type: 'NODES_UPDATE',
      senderId: this.config.nodeId,
      senderName: this.config.displayName,
      timestamp: new Date().toISOString(),
      payload: { nodes: this.config.nodes }
    };
    this.broadcast(msg);
  }

  private startClusterHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.dataChannels.size === 0) return;
      const pres = presenceManager.getCurrentPresence();
      if (pres) {
        const msg: IClusterMessage = {
          id: `pres_${Date.now()}`,
          type: 'PRESENCE_HEARTBEAT',
          senderId: this.config.nodeId,
          senderName: this.config.displayName,
          timestamp: new Date().toISOString(),
          payload: pres
        };
        this.broadcast(msg);
      }
    }, 8000);
  }

  private async processClientActionAtHost(senderNodeId: string, msg: IClusterMessage): Promise<void> {
    const { actionType, payload, username, displayName, role } = msg.payload || {};
    try {
      if (actionType === 'UPDATE_RATE_NS' || actionType === 'UPDATE_RATE_CL') {
        if (payload?.rate) {
          await db.productivityQualityRates.put(payload.rate);
        }
      } else if (actionType === 'ASSIGN_SHIFT') {
        if (payload?.roster) {
          await db.shiftRosters.put(payload.roster);
        }
      }

      // Ghi audit log trên Master Host
      if (username) {
        await logUserAction({
          username,
          displayName: displayName || username,
          role: role || 'Warehouse Admin',
          actionType: actionType || 'UNKNOWN_ACTION',
          targetEntity: `${msg.payload?.targetEntity || 'Cluster Action'} (từ máy trạm ${senderNodeId})`,
          details: `Đồng bộ qua WebRTC RTCDataChannel: ${msg.payload?.details || ''}`
        });
      }

      // Trả ACK xác nhận về cho Client
      this.sendMessage(senderNodeId, {
        id: `ack_${Date.now()}`,
        type: 'ACTION_ACK',
        senderId: this.config.nodeId,
        senderName: this.config.displayName,
        timestamp: new Date().toISOString(),
        payload: { originalActionId: msg.id, success: true }
      });
    } catch (e: any) {
      console.error('Host xử lý Action thất bại:', e);
    }
  }

  public sendMessage(targetNodeId: string, msg: IClusterMessage): boolean {
    const channel = this.dataChannels.get(targetNodeId);
    if (channel && channel.readyState === 'open') {
      channel.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  public broadcast(msg: IClusterMessage): void {
    this.dataChannels.forEach((channel) => {
      if (channel.readyState === 'open') {
        channel.send(JSON.stringify(msg));
      }
    });
  }

  public updateNodeStatus(nodeId: string, status: NodeConnectionStatus): void {
    const node = this.config.nodes.find(n => n.id === nodeId);
    if (node) {
      node.status = status;
      node.lastPing = new Date().toLocaleTimeString();
      this.saveConfig({ nodes: [...this.config.nodes] });
      this.statusListeners.forEach(fn => fn(this.currentStatus));
      if (this.config.nodeRole === 'HOST') {
        this.broadcastNodesUpdate();
      }
    }
  }

  /**
   * Tạo Token ghép nối thủ công dạng Base64 (dành cho môi trường offline file:///)
   */
  public async createPairingOfferToken(clientId: string): Promise<string> {
    const offerJson = await this.createOfferForClient(clientId);
    return btoa(unescape(encodeURIComponent(offerJson)));
  }

  public async acceptOfferTokenAndCreateAnswer(token: string): Promise<string> {
    const offerJson = decodeURIComponent(escape(atob(token.trim())));
    const answerJson = await this.receiveOfferAndCreateAnswer(offerJson);
    return btoa(unescape(encodeURIComponent(answerJson)));
  }

  public async acceptAnswerToken(clientId: string, token: string): Promise<void> {
    const answerJson = decodeURIComponent(escape(atob(token.trim())));
    await this.receiveAnswer(clientId, answerJson);
  }

  public disconnectAll(): void {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.httpPollTimer) {
      clearInterval(this.httpPollTimer);
      this.httpPollTimer = null;
    }
    this.dataChannels.forEach(dc => {
      try { dc.close(); } catch {}
    });
    this.peerConnections.forEach(pc => {
      try { pc.close(); } catch {}
    });
    this.dataChannels.clear();
    this.peerConnections.clear();
    this.setStatus('IDLE', 'Đã ngắt toàn bộ kết nối');
  }
}

export const clusterService = new WebRTCClusterService();
