/**
 * WebRTC P2P Cluster Service — Star Topology (1 Host - 5 Clients via RTCDataChannel)
 * Đáp ứng kiến trúc Local-First In-Browser:
 * - 100% In-Browser trên Microsoft Edge
 * - Không spawn tiến trình .exe, không mở port OS (vượt CrowdStrike Falcon EDR)
 * - Tự động trao đổi tín hiệu (Signaling Bus) qua BroadcastChannel và Storage Event Bus
 * - Tự động nhận diện kết nối, timeout 8 giây chống treo vô tận
 * - Đồng bộ danh sách online users thời gian thực giữa các máy qua RTCDataChannel
 */

import { IClusterConfig, IClusterNode, IClusterMessage, DEFAULT_CLUSTER_CONFIG, NodeRole, NodeConnectionStatus } from '../types/cluster';
import { db } from '../db';
import { logUserAction } from './audit-log-service';
import { presenceManager } from './presence-service';

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
    }
  }

  private emitSignal(signal: ISignalEnvelope): void {
    try {
      this.signalingChannel?.postMessage(signal);
    } catch {}
    try {
      localStorage.setItem('smarthr_p2p_signaling_event', JSON.stringify({ ...signal, _rnd: Math.random() }));
    } catch {}
  }

  private async handleSignalingMessage(signal: ISignalEnvelope): Promise<void> {
    if (!signal || !signal.type) return;

    // 1. Host nhận tín hiệu chào hỏi từ máy Client
    if (this.config.nodeRole === 'HOST' && signal.type === 'CLIENT_HELLO') {
      const clientId = signal.clientId;
      if (!clientId || clientId === this.config.nodeId) return;

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

    // MỐC XÁC ĐỊNH KẾT NỐI (TIMEOUT 8 GIÂY):
    // Tránh treo load vô tận khi Host chưa bật hoặc chưa online
    this.connectTimeoutTimer = setTimeout(() => {
      if (this.currentStatus === 'SIGNALING') {
        this.setStatus('HOST_OFFLINE', 'Host Kiều chưa online hoặc chưa khởi chạy. Hệ thống đang hoạt động ở chế độ Cục Bộ (Local-First).');
      }
    }, 8000);
  }

  /**
   * Tạo gói tin Offer SDP để trao đổi file Signaling
   */
  public async createOfferForClient(clientId: string): Promise<string> {
    // Đóng PC cũ nếu có
    const oldPc = this.peerConnections.get(clientId);
    if (oldPc) oldPc.close();

    const pc = new RTCPeerConnection({
      iceServers: [] // Chạy mạng LAN nội bộ, không cần STUN bên ngoài
    });
    this.peerConnections.set(clientId, pc);

    const dc = pc.createDataChannel('smarthr-cluster-channel', {
      ordered: true
    });
    this.setupDataChannel(clientId, dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

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
    if (oldPc) oldPc.close();

    const pc = new RTCPeerConnection({ iceServers: [] });
    this.peerConnections.set('HOST', pc);

    pc.ondatachannel = (e) => {
      this.setupDataChannel('HOST', e.channel);
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offerData.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

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

      this.startClusterHeartbeat();
    };

    channel.onclose = () => {
      this.updateNodeStatus(remoteNodeId, 'DISCONNECTED');
      this.dataChannels.delete(remoteNodeId);
      this.peerConnections.delete(remoteNodeId);

      if (this.config.nodeRole === 'CLIENT') {
        this.setStatus('DISCONNECTED', 'Đã ngắt kết nối với Host Kiều');
      } else {
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
      }
    } else if (msg.type === 'HANDSHAKE_ACK') {
      this.setStatus('CONNECTED', 'Đã kết nối thành công với Host Kiều');
      this.updateNodeStatus('HOST', 'CONNECTED');
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
    }
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
    this.dataChannels.forEach(dc => dc.close());
    this.peerConnections.forEach(pc => pc.close());
    this.dataChannels.clear();
    this.peerConnections.clear();
    this.setStatus('IDLE', 'Đã ngắt toàn bộ kết nối');
  }
}

export const clusterService = new WebRTCClusterService();
