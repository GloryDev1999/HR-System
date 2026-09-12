import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { clusterService } from '../services/webrtc-cluster-service';
import { DEFAULT_CLUSTER_CONFIG, IClusterMessage } from '../types/cluster';

describe('WebRTC P2P Star-Topology Cluster Service', () => {
  beforeEach(() => {
    localStorage.clear();
    clusterService.saveConfig(DEFAULT_CLUSTER_CONFIG);
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

  it('có thể cấu hình máy trạm làm Client (Vinh, Nguyet Anh, Han)', async () => {
    await clusterService.initializeNode('CLIENT', 'CLIENT_VINH_WH', 'Vinh(Glory) - Kho WH');

    const config = clusterService.getConfig();
    expect(config.nodeRole).toBe('CLIENT');
    expect(config.nodeId).toBe('CLIENT_VINH_WH');
    expect(clusterService.getStatus()).toBe('SIGNALING');
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
});
