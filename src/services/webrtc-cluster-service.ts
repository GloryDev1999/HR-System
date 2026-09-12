/**
 * WebRTC P2P Cluster Service — Star Topology (1 Host - 5 Clients via RTCDataChannel)
 * Đáp ứng kiến trúc mô tả trong gemini-code-1789186380234.md:
 * - 100% In-Browser trên Microsoft Edge
 * - Không spawn tiến trình .exe, không mở port OS (vượt CrowdStrike Falcon EDR)
 * - Trao đổi tín hiệu (Signaling) qua file JSON trung gian (OneDrive / Shared Folder)
 */

import { IClusterConfig, IClusterNode, IClusterMessage, DEFAULT_CLUSTER_CONFIG, NodeRole, NodeConnectionStatus } from '../types/cluster';
import { db } from '../db';
import { logUserAction } from './audit-log-service';

type MessageHandler = (msg: IClusterMessage) => void;
type StatusChangeHandler = (status: NodeConnectionStatus, details?: string) => void;

class WebRTCClusterService {
  private config: IClusterConfig = { ...DEFAULT_CLUSTER_CONFIG };
  private peerConnections = new Map<string, RTCPeerConnection>();
  private dataChannels = new Map<string, RTCDataChannel>();
  private messageListeners = new Set<MessageHandler>();
  private statusListeners = new Set<StatusChangeHandler>();
  private currentStatus: NodeConnectionStatus = 'IDLE';

  constructor() {
    this.loadConfig();
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
    // Host chuẩn bị các kênh RTCDataChannel đón 5 máy client
    this.setStatus('SIGNALING', 'Host đang sẵn sàng tiếp nhận kết nối từ các máy trạm');
  }

  private initClientMode(): void {
    this.setStatus('SIGNALING', 'Client đang tìm kiếm Host trong thư mục chia sẻ');
  }

  /**
   * Tạo gói tin Offer SDP để trao đổi file Signaling
   */
  public async createOfferForClient(clientId: string): Promise<string> {
    const pc = new RTCPeerConnection({
      iceServers: [] // Chạy mạng nội bộ LAN, không cần STUN ngoài internet
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
    this.setStatus('CONNECTED', `Đã kết nối thành công với Client: ${clientId}`);
  }

  private setupDataChannel(remoteNodeId: string, channel: RTCDataChannel): void {
    this.dataChannels.set(remoteNodeId, channel);

    channel.onopen = () => {
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
    };

    channel.onclose = () => {
      this.updateNodeStatus(remoteNodeId, 'DISCONNECTED');
      this.dataChannels.delete(remoteNodeId);
      if (this.dataChannels.size === 0) {
        this.setStatus('DISCONNECTED', 'Đã ngắt kết nối');
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
    // Thông báo cho các listeners
    this.messageListeners.forEach(fn => fn(msg));

    // Nếu là Host: xử lý Action nghiệp vụ gửi từ Client và ghi vào Master DB
    if (this.config.nodeRole === 'HOST' && msg.type === 'ACTION') {
      this.processClientActionAtHost(senderNodeId, msg);
    }
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

  private updateNodeStatus(nodeId: string, status: NodeConnectionStatus): void {
    const node = this.config.nodes.find(n => n.id === nodeId);
    if (node) {
      node.status = status;
      node.lastPing = new Date().toLocaleTimeString();
      this.saveConfig({ nodes: [...this.config.nodes] });
    }
  }

  public disconnectAll(): void {
    this.dataChannels.forEach(dc => dc.close());
    this.peerConnections.forEach(pc => pc.close());
    this.dataChannels.clear();
    this.peerConnections.clear();
    this.setStatus('DISCONNECTED', 'Đã đóng toàn bộ kết nối');
  }
}

export const clusterService = new WebRTCClusterService();
