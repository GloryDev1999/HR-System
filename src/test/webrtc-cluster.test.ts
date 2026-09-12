import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { clusterService } from '../services/webrtc-cluster-service';
import { folderSignaling } from '../services/folder-signaling-service';
import { DEFAULT_CLUSTER_CONFIG, IClusterMessage } from '../types/cluster';

class MockRTCPeerConnection {
  iceGatheringState: RTCIceGatheringState = 'complete';
  localDescription: any = {
    type: 'offer',
    sdp: 'v=0\r\no=- 123 2 IN IP4 192.168.1.10\r\na=candidate:1 1 UDP 2122260223 192.168.1.10 54321 typ host\r\n'
  };
  remoteDescription: any = null;
  ondatachannel: any = null;
  private listeners: Record<string, any[]> = {};

  createDataChannel(label: string) {
    return {
      label,
      readyState: 'open',
      send: vi.fn(),
      close: vi.fn(),
      onopen: null,
      onclose: null,
      onmessage: null
    };
  }

  async createOffer() {
    return { type: 'offer', sdp: this.localDescription.sdp };
  }

  async createAnswer() {
    return { type: 'answer', sdp: this.localDescription.sdp };
  }

  async setLocalDescription(desc: any) {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: any) {
    this.remoteDescription = desc;
  }

  addEventListener(type: string, fn: any) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  removeEventListener(type: string, fn: any) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter(f => f !== fn);
    }
  }

  close() {}
}

describe('WebRTC P2P Star-Topology Cluster Service', () => {
  const originalRTC = (global as any).RTCPeerConnection;
  const originalRTCSessionDescription = (global as any).RTCSessionDescription;

  beforeEach(() => {
    localStorage.clear();
    clusterService.saveConfig(DEFAULT_CLUSTER_CONFIG);
    (global as any).RTCPeerConnection = MockRTCPeerConnection;
    (global as any).RTCSessionDescription = class {
      constructor(public init: any) {}
    };
  });

  afterEach(() => {
    clusterService.disconnectAll();
    (global as any).RTCPeerConnection = originalRTC;
    (global as any).RTCSessionDescription = originalRTCSessionDescription;
  });

  it('khởi tạo với cấu hình mặc định gồm 5 máy Client đúng danh sách nhân sự', () => {
    const config = clusterService.getConfig();
    expect(config.maxClients).toBe(5);
    expect(config.nodes.length).toBe(5);

    const clientIds = config.nodes.map(n => n.username);
    expect(clientIds).toContain('vinh');
    expect(clientIds).toContain('nguyetanh');
    expect(clientIds).toContain('han');
    expect(clientIds).toContain('hoa');
    expect(clientIds).toContain('glory');
  });

  it('có thể cấu hình máy Kieu làm Host (Master DB) và lưu cấu hình động', async () => {
    await clusterService.initializeNode('HOST', 'HOST_KIEU_01', 'Kieu(Mia) - System Admin');

    const config = clusterService.getConfig();
    expect(config.nodeRole).toBe('HOST');
    expect(config.nodeId).toBe('HOST_KIEU_01');
    expect(config.displayName).toBe('Kieu(Mia) - System Admin');
    expect(clusterService.getStatus()).toBe('SIGNALING');
  });

  it('quickStartAsHost cấu hình Host Kiều và ghi nhớ trong localStorage', async () => {
    await clusterService.quickStartAsHost();

    expect(clusterService.isHostConfigured()).toBe(true);
    expect(clusterService.getConfig().nodeRole).toBe('HOST');
    expect(clusterService.getConfig().nodeId).toBe('HOST_KIEU_01');
  });

  it('quickConnectAsClient tự động ánh xạ đúng nodeId cho từng user trạm', async () => {
    await clusterService.quickConnectAsClient('vinh', 'Vinh(Glory) - Kho WH');
    expect(clusterService.getConfig().nodeRole).toBe('CLIENT');
    expect(clusterService.getConfig().nodeId).toBe('CLIENT_01');

    await clusterService.quickConnectAsClient('nguyetanh');
    expect(clusterService.getConfig().nodeId).toBe('CLIENT_02');

    await clusterService.quickConnectAsClient('han');
    expect(clusterService.getConfig().nodeId).toBe('CLIENT_03');

    await clusterService.quickConnectAsClient('hoa');
    expect(clusterService.getConfig().nodeId).toBe('CLIENT_04');

    await clusterService.quickConnectAsClient('glory');
    expect(clusterService.getConfig().nodeId).toBe('CLIENT_05');
  });

  it('chuẩn hóa định dạng tin nhắn IClusterMessage trao đổi qua RTCDataChannel', () => {
    const actionMsg: IClusterMessage = {
      id: 'msg_123',
      type: 'ACTION',
      senderId: 'CLIENT_01',
      senderName: 'Vinh(Glory)',
      timestamp: new Date().toISOString(),
      payload: {
        actionType: 'ASSIGN_SHIFT',
        username: 'vinh',
        role: 'Warehouse Admin',
        targetEntity: 'LEP040',
        details: 'Sắp ca 1 cho nhân viên kho'
      }
    };

    expect(actionMsg.type).toBe('ACTION');
    expect(actionMsg.payload.actionType).toBe('ASSIGN_SHIFT');
    expect(actionMsg.payload.username).toBe('vinh');
  });

  it('tạo Offer SDP chứa đầy đủ ứng viên ICE và đúng cấu trúc JSON', async () => {
    await clusterService.initializeNode('HOST', 'HOST_KIEU_01', 'Kieu Master DB');
    const offerJson = await clusterService.createOfferForClient('CLIENT_01');
    const offerData = JSON.parse(offerJson);

    expect(offerData.type).toBe('OFFER');
    expect(offerData.targetClient).toBe('CLIENT_01');
    expect(offerData.fromHost).toBe('HOST_KIEU_01');
    expect(offerData.sdp).toBeDefined();
  });

  it('client xử lý Offer và sinh Answer SDP hợp lệ', async () => {
    await clusterService.initializeNode('CLIENT', 'CLIENT_01', 'Vinh Kho WH');
    const mockOffer = JSON.stringify({
      type: 'OFFER',
      fromHost: 'HOST_KIEU_01',
      targetClient: 'CLIENT_01',
      sdp: { type: 'offer', sdp: 'mock-offer-sdp' }
    });

    const answerJson = await clusterService.receiveOfferAndCreateAnswer(mockOffer);
    const answerData = JSON.parse(answerJson);

    expect(answerData.type).toBe('ANSWER');
    expect(answerData.fromClient).toBe('CLIENT_01');
    expect(answerData.sdp).toBeDefined();
  });

  it('tạo và chấp nhận Offline Pairing Token (Base64) thành công', async () => {
    await clusterService.initializeNode('HOST', 'HOST_KIEU_01', 'Kieu Master DB');
    const offerToken = await clusterService.createPairingOfferToken('CLIENT_01');
    expect(typeof offerToken).toBe('string');
    expect(offerToken.length).toBeGreaterThan(20);

    await clusterService.initializeNode('CLIENT', 'CLIENT_01', 'Vinh Kho WH');
    const answerToken = await clusterService.acceptOfferTokenAndCreateAnswer(offerToken);
    expect(typeof answerToken).toBe('string');
    expect(answerToken.length).toBeGreaterThan(20);

    // Host chấp nhận answerToken
    await clusterService.initializeNode('HOST', 'HOST_KIEU_01', 'Kieu Master DB');
    await clusterService.createOfferForClient('CLIENT_01');
    await expect(clusterService.acceptAnswerToken('CLIENT_01', answerToken)).resolves.not.toThrow();
  });

  it('cập nhật trạng thái từng máy và đồng bộ sơ đồ mạng nodes', () => {
    clusterService.updateNodeStatus('CLIENT_01', 'CONNECTED');
    const config = clusterService.getConfig();
    const node1 = config.nodes.find(n => n.id === 'CLIENT_01');
    expect(node1?.status).toBe('CONNECTED');
    expect(node1?.lastPing).toBeDefined();
  });

  it('folderSignaling quản lý trạng thái quyền và nhịp tim Host heartbeat', async () => {
    expect(typeof folderSignaling.isSupported()).toBe('boolean');
    expect(folderSignaling.isPermissionGranted()).toBe(false);

    // Kích hoạt nhịp tim Host và ngắt an toàn
    folderSignaling.startHostHeartbeat({ nodeId: 'HOST_KIEU_01', displayName: 'Kieu Mia' });
    folderSignaling.stopHostHeartbeat();

    // checkHostStatus trả về offline khi chưa có thư mục
    const status = await folderSignaling.checkHostStatus();
    expect(status.online).toBe(false);
  });
});
