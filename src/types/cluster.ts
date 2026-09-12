export type NodeRole = 'HOST' | 'CLIENT';

export type NodeConnectionStatus = 'IDLE' | 'SIGNALING' | 'CONNECTED' | 'DISCONNECTED' | 'HOST_OFFLINE' | 'ERROR';

export interface IClusterNode {
  id: string;
  name: string;
  username: string;
  role: string;
  departmentScope?: string | null;
  allowedActions: string[];
  status: NodeConnectionStatus;
  lastPing?: string;
}

export interface IClusterConfig {
  nodeRole: NodeRole;
  nodeId: string;
  displayName: string;
  syncFolderName: string;
  pollIntervalMs: number;
  maxClients: number;
  nodes: IClusterNode[];
}

export interface IClusterMessage {
  id: string;
  type: 'HANDSHAKE' | 'HANDSHAKE_ACK' | 'SYNC_REQUEST' | 'SYNC_RESPONSE' | 'ACTION' | 'ACTION_ACK' | 'PING' | 'PONG' | 'PRESENCE_HEARTBEAT' | 'NODES_UPDATE';
  senderId: string;
  senderName: string;
  timestamp: string;
  payload?: any;
}

export const DEFAULT_CLUSTER_CONFIG: IClusterConfig = {
  nodeRole: 'CLIENT',
  nodeId: 'CLIENT_NODE_01',
  displayName: 'Máy Trạm Chi Nhánh',
  syncFolderName: 'HR_Signaling_Data',
  pollIntervalMs: 2500,
  maxClients: 5,
  nodes: [
    {
      id: 'CLIENT_01',
      name: 'Vinh(Glory) - Kho WH',
      username: 'vinh',
      role: 'Warehouse Admin',
      departmentScope: 'WH',
      allowedActions: ['ASSIGN_SHIFT_WH', 'VIEW_WH'],
      status: 'IDLE'
    },
    {
      id: 'CLIENT_02',
      name: 'Nguyet Anh - Quản Lý QC',
      username: 'nguyetanh',
      role: 'QC Admin',
      departmentScope: 'QC',
      allowedActions: ['ASSIGN_SHIFT_QC', 'UPDATE_RATE_CL', 'VIEW_QC'],
      status: 'IDLE'
    },
    {
      id: 'CLIENT_03',
      name: 'Han - Quản Lý Sản Xuất',
      username: 'han',
      role: 'Production Admin',
      departmentScope: 'Production',
      allowedActions: ['ASSIGN_SHIFT_PRD', 'UPDATE_RATE_NS', 'VIEW_PRD'],
      status: 'IDLE'
    },
    {
      id: 'CLIENT_04',
      name: 'Hoa(Molly) - Phòng Nhân Sự',
      username: 'hoa',
      role: 'HR Manager',
      departmentScope: null,
      allowedActions: ['ALL_ACCESS_EXCEPT_SETTINGS'],
      status: 'IDLE'
    },
    {
      id: 'CLIENT_05',
      name: 'Glory(Software) - Kỹ Thuật Hệ Thống',
      username: 'glory',
      role: 'AD System',
      departmentScope: null,
      allowedActions: ['ALL_ACCESS'],
      status: 'IDLE'
    }
  ]
};
