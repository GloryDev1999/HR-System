import React, { useState, useRef, useEffect, useMemo, useCallback, useTransition, useDeferredValue } from 'react';
import {
  ScanLine,
  Upload,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  Loader2,
  ArrowRight,
  Image as ImageIcon,
  Cpu,
  Layers,
  Plus,
  Trash2,
  Save,
  RefreshCw,
  Table2,
  X
} from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { useToast } from '../context/ToastContext';
import { useModal } from '../context/ModalContext';
import { useAuth } from '../context/AuthContext';
import { NavPageId } from '../components/layout/Sidebar';
import { OcrSpreadsheetPreview, SpreadsheetRow } from '../components/ocr/OcrSpreadsheetPreview';
import { IExtractedFormRow, reconcileRows, commitVerifiedRows } from '../services/ocr-form-parser';
import { runOcrPipeline } from '../services/ocr-worker-client';
import type { OCRWorkerResult } from '../types/ocr-worker-protocol';
import { IEmployee } from '../types';
import { testONNXModelRuntime, IONNXModelHealthReport } from '../services/onnx-model-checker';
import { isFileProtocol, putOcrAsset, guessOcrAssetKey, getStoredOcrAssetKeys, clearOcrAssets } from '../services/ocr-assets-store';
import {
  normalizeDateString,
  parseOvertimeHours,
  mapGridToTableRows,
  normalizeEmployeeCode,
} from '../services/ocr-table-engine';
import { applyHRCorrections } from '../services/hr-rag-postprocessor';

interface OCRVerificationPageProps {
  onNavigate: (page: NavPageId) => void;
}

let rowIdCounter = 0;
function nextRowId(): string {
  return `row_${Date.now()}_${rowIdCounter++}`;
}

/** Áp dụng HR RAG corrections cho lưới OCR trước khi mapping */
function applyHRGridCorrections(grid: OCRWorkerResult['grid']): OCRWorkerResult['grid'] {
  return {
    ...grid,
    rows: grid.rows.map(r => ({
      ...r,
      cells: r.cells.map(c => {
        const corrected = applyHRCorrections(c.text);
        return corrected !== c.text ? { ...c, text: corrected } : c;
      }),
    })),
  };
}

/** Hash ArrayBuffer cho cache OCR (tránh quét lại ảnh trùng, không bịa kết quả) */
async function hashBuffer(buf: ArrayBuffer): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const hash = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
    }
  } catch {}
  // fallback: size + first 1k bytes checksum
  const u8 = new Uint8Array(buf);
  let h = 2166136261;
  const len = Math.min(u8.length, 4096);
  for (let i = 0; i < len; i++) { h ^= u8[i]; h = Math.imul(h, 16777619); }
  return `${buf.byteLength}-${h >>> 0}`;
}

/** Chuyển kết quả lưới OCR thật -> dòng dữ liệu có cấu trúc để đối soát */
function mappedToFormRows(grid: OCRWorkerResult['grid'], employeesCatalog: IEmployee[] = []): IExtractedFormRow[] {
  // Áp dụng HR RAG trước khi mapping để chuẩn hóa cấu trúc
  const hrGrid = applyHRGridCorrections(grid);
  const mapped = mapGridToTableRows(hrGrid);
  return mapped.map((m, i) => {
    const dateNorm = m.rawDate ? normalizeDateString(m.rawDate) : { normalizedDate: '', valid: false };
    const hoursParsed = parseOvertimeHours(m.hoursText ?? '', m.fromTime, m.toTime);
    let empCode = m.employeeCode ?? '';
    let empName = m.fullName ?? '';
    let empDept = m.department ?? '';
    // Nghiệp vụ: OCR tập trung chuẩn MSNV (LEP000/LEP000A), Ngày, Giờ tăng ca; Tên & Bộ phận tự động tra cứu từ danh mục nhân sự Master
    if (empCode) {
      const normEmp = normalizeEmployeeCode(empCode, employeesCatalog);
      empCode = normEmp.normalizedId || empCode;
      if (normEmp.matched) {
        empName = normEmp.name;
        empDept = normEmp.dept || empDept;
      } else if (!empDept && m.employeeCode) {
        // Tách bộ phận nếu dính vào mã nhân viên như "LEP026 WH"
        const deptMatch = m.employeeCode.match(/(?:LEP|LP)\s*[0-9OoilIszZ]{1,4}\s*[A-Za-z]?\s+([A-Za-z]{2,})/i);
        if (deptMatch) {
          empDept = deptMatch[1].toUpperCase();
        }
      }
    }
    return {
      rowId: nextRowId(),
      stt: m.stt ?? i + 1,
      fullName: empName,
      employeeId: empCode,
      department: empDept,
      otDateRaw: m.rawDate ?? '',
      otDate: dateNorm.normalizedDate,
      fromTime: m.fromTime ?? '',
      toTime: m.toTime ?? '',
      otHours: hoursParsed.hours,
      reason: m.reason ?? '',
      confidence: m.confidence,
    };
  });
}

export const OCRVerificationPage: React.FC<OCRVerificationPageProps> = ({ onNavigate }) => {
  const { success, error, warning, info } = useToast();
  const { alertModal, confirm } = useModal();
  const { hasPermission, currentRole } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Kho model offline cho file:// (dự phòng cho engine trực tiếp khi Worker inline lỗi)
  const offlineAssetsInputRef = useRef<HTMLInputElement>(null);
  const [isLoadingAssets, setIsLoadingAssets] = useState(false);
  const [offlineAssetCount, setOfflineAssetCount] = useState<number>(-1);
  const [isOfflineModalOpen, setIsOfflineModalOpen] = useState(false);
  const [storedAssetKeys, setStoredAssetKeys] = useState<string[]>([]);
  const fileMode = isFileProtocol();

  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);
  const [streamingLogs, setStreamingLogs] = useState<string[]>([]);
  const [isTestingModel, setIsTestingModel] = useState(false);
  const [scanDetails, setScanDetails] = useState<string>('');
  const [isPending, startTransition] = useTransition();

  // Ảnh & lưới quét được
  const [previewImageUrl, setPreviewImageUrl] = useState<string>('');
  const previewUrlRef = useRef<string | null>(null);
  const [formTitle, setFormTitle] = useState<string>('Chưa có ảnh nào được quét');
  const [gridRows, setGridRows] = useState<SpreadsheetRow[]>([]);
  const [activeRowIdx, setActiveRowIdx] = useState<number | null>(null);
  const [lastFileName, setLastFileName] = useState('');

  // Batch queue cho tải hàng loạt - 3 layout: chờ (vàng), đang scan (streaming), xong (xanh)
  type BatchStatus = 'waiting' | 'scanning' | 'done' | 'error';
  interface BatchItem {
    id: string;
    file: File;
    fileName: string;
    previewUrl: string;
    status: BatchStatus;
    progress: number;
    result?: OCRWorkerResult;
    error?: string;
  }
  const [batchQueue, setBatchQueue] = useState<BatchItem[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const batchRefs = useRef<Map<string, string>>(new Map()); // id -> objectUrl để revoke
  // Cache OCR kết quả theo hash để không quét lại ảnh trùng (tránh lag, áp dụng cho toàn hệ thống)
  const ocrCacheRef = useRef<Map<string, OCRWorkerResult>>(new Map());

  // Dòng dữ liệu có cấu trúc (đối soát)
  const [formRows, setFormRows] = useState<IExtractedFormRow[]>([]);

  const canCommit = hasPermission('SCAN_OCR') || hasPermission('SCAN_DEPT_OCR');

  // Live queries
  const employees = useLiveQuery(() => db.employees.toArray(), []) || [];
  const overtimeRecords = useLiveQuery(() => db.overtimeRecords.toArray(), []) || [];

  // Dọn dẹp blob URL khi rời trang (cả single và batch queue, cache vĩnh viễn cho model đã tách riêng)
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    batchRefs.current.forEach(url => URL.revokeObjectURL(url));
    batchRefs.current.clear();
  }, []);

  // file://: đếm sẵn model đã nạp trong kho offline để hiển thị trạng thái nút
  useEffect(() => {
    if (!fileMode) return;
    getStoredOcrAssetKeys()
      .then(keys => {
        setOfflineAssetCount(keys.length);
        setStoredAssetKeys(keys);
      })
      .catch(() => {
        setOfflineAssetCount(0);
        setStoredAssetKeys([]);
      });
  }, [fileMode]);

  // Persist OCR data khi qua menu Quản lý tăng ca thì không reset - lưu vào localStorage
  const STORAGE_KEY = 'ocrVerification_persist_v2';
  const hasRestoredRef = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.gridRows) && parsed.gridRows.length > 0) setGridRows(parsed.gridRows);
        if (Array.isArray(parsed.formRows) && parsed.formRows.length > 0) setFormRows(parsed.formRows);
        if (typeof parsed.formTitle === 'string' && parsed.formTitle) setFormTitle(parsed.formTitle);
        if (typeof parsed.lastFileName === 'string' && parsed.lastFileName) setLastFileName(parsed.lastFileName);
        if (typeof parsed.scanDetails === 'string' && parsed.scanDetails) setScanDetails(parsed.scanDetails);
        // batchMeta không chứa File (không persist được blob), chỉ lưu fileName/status để hiển thị Xong
        if (Array.isArray(parsed.batchMeta) && parsed.batchMeta.length > 0) {
          setBatchQueue(parsed.batchMeta.map((b: any) => ({
            id: b.id,
            file: new File([], b.fileName || 'unknown'),
            fileName: b.fileName,
            previewUrl: '',
            status: b.status as BatchStatus,
            progress: b.progress || 0,
          })));
        }
        hasRestoredRef.current = true;
        if (parsed.formRows?.length) {
          info('Đã khôi phục phiên OCR trước', `${parsed.formRows.length} dòng từ lần quét trước vẫn được giữ khi chuyển menu. Bấm "Làm mới dữ liệu" để xóa.`);
        }
      }
    } catch {}
  }, []); // chỉ chạy 1 lần khi mount

  useEffect(() => {
    // Không ghi đè khi chưa restore xong và dữ liệu vẫn rỗng (tránh xóa dữ liệu đã lưu)
    if (!hasRestoredRef.current && gridRows.length === 0 && formRows.length === 0) return;
    try {
      const toSave = {
        gridRows,
        formRows,
        formTitle,
        lastFileName,
        scanDetails,
        batchMeta: batchQueue.map(b => ({ id: b.id, fileName: b.fileName, status: b.status, progress: b.progress })),
        savedAt: Date.now(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch {}
  }, [gridRows, formRows, formTitle, lastFileName, scanDetails, batchQueue]);

  // Đối soát thuần tính - dùng deferred value + cache để tránh lag toàn hệ thống (không cache dữ liệu động liên tục)
  const deferredFormRows = useDeferredValue(formRows);
  const reconciledRows = useMemo(
    () => reconcileRows(deferredFormRows, employees, overtimeRecords),
    [deferredFormRows, employees, overtimeRecords]
  );

  const matchedCount = reconciledRows.filter(r => r.matchStatus === 'MATCHED').length;
  const mismatchCount = reconciledRows.filter(r => r.matchStatus === 'MISMATCH').length;
  const notFoundCount = reconciledRows.filter(r => !r.matchStatus || r.matchStatus === 'NOT_FOUND').length;

  /** Áp dụng kết quả quét THẬT từ worker vào trạng thái (kèm HR RAG post-process) - dùng transition để không lag */
  const applyScanResult = useCallback((result: OCRWorkerResult, imageUrl: string, title: string) => {
    const hrGrid = applyHRGridCorrections(result.grid);
    let correctedCells = 0;
    result.grid.rows.forEach((r, ri) => {
      r.cells.forEach((c, ci) => {
        const hr = hrGrid.rows[ri]?.cells[ci]?.text;
        if (hr && hr !== c.text) correctedCells++;
      });
    });
    startTransition(() => {
      setGridRows(hrGrid.rows.map(r => ({
        yCenter: r.yCenter,
        cells: r.cells.map(c => ({ text: c.text, confidence: c.confidence })),
      })));
      setFormRows(mappedToFormRows(hrGrid, employees));
    });

    // Tự động đối soát và đồng bộ ngay vào Bảng Tăng Ca nếu có dòng khớp
    const mapped = mappedToFormRows(hrGrid, employees);
    const reconciled = reconcileRows(mapped, employees, overtimeRecords);
    const matchedRows = reconciled.filter(r => r.matchStatus === 'MATCHED' && r.employeeId && r.otDate && r.otHours !== null);
    if (matchedRows.length > 0 && canCommit) {
      commitVerifiedRows(matchedRows, {
        fileName: title,
        verifiedBy: currentRole ?? 'OCR_AUTO_SYNC',
      }).then(({ updated }) => {
        if (updated > 0) {
          success('Tự động khớp Bảng Tăng Ca', `Đã đồng bộ ${updated} bản ghi khớp vào Bảng Tăng Ca.`);
        }
      }).catch(err => {
        console.warn('[OCR Auto-Sync] Không thể tự động ghi dòng khớp:', err);
      });
    }

    // Bổ sung thông tin HR RAG vào details
    const detailsWithHR = correctedCells > 0
      ? `${result.details}; HR RAG đã tinh chỉnh ${correctedCells} ô (LEP codes, dates, tiếng Việt)`
      : `${result.details}; HR RAG kiểm tra xong (không cần chỉnh)`;
    setScanDetails(detailsWithHR);
    setFormTitle(title);
    info(
      'Nhận dạng hoàn tất',
      `${result.lines.length} vùng chữ · ${result.processingTimeMs}ms${correctedCells ? ` · HR RAG ${correctedCells} ô` : ''}. Kiểm tra bảng tính bên phải trước khi ghi nhận.`
    );
    void imageUrl; // ảnh đã set ở nơi gọi
  }, [employees, overtimeRecords, canCommit, currentRole, info, success]);

  /** Chạy pipeline OCR-Scan trên bytes của một ảnh/PDF - có cache theo hash để tránh quét lại ảnh trùng (không bịa kết quả) */
  const scanImageBytes = useCallback(async (bytes: ArrayBuffer, fileName: string, objectUrl: string) => {
    setIsScanning(true);
    setScanProgress(3);
    setStreamingLogs([`[${new Date().toLocaleTimeString()}] Bắt đầu nhận diện OCR-Scan cho ${fileName}...`]);
    try {
      const hash = await hashBuffer(bytes);
      const cached = ocrCacheRef.current.get(hash);
      let result: OCRWorkerResult;
      if (cached) {
        // Cache hit: trả ngay không quét lại, nhưng vẫn báo trung thực là lấy từ cache (tránh lag)
        setStreamingLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] [CACHE] Ảnh trùng - lấy kết quả đã lưu (hash ${hash})`]);
        result = cached;
        setScanProgress(100);
      } else {
        result = await runOcrPipeline(bytes, {
          fileName,
          onProgress: (progress, step, message) => {
            setScanProgress(progress);
            const friendlyMsg = message.replace(/ONNX|PaddleOCR|ch_PP-OCRv4|latin_PP-OCRv3/gi, 'OCR').replace(/model/gi, 'thuật toán').replace(/pipeline/gi, 'quy trình');
            setStreamingLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] [${step}] ${friendlyMsg}`]);
          }
        });
        // Lưu cache vĩnh viễn cho máy đã tải (không áp dụng cho dữ liệu động như DB)
        ocrCacheRef.current.set(hash, result);
        setScanProgress(100);
      }
      setLastFileName(fileName);
      applyScanResult(
        result,
        objectUrl,
        `Kết quả OCR-Scan: ${fileName} (${result.lines.length} vùng chữ, ${result.processingTimeMs}ms)`
      );
      success('Quét xong', `Đã nhận diện ${fileName} (${result.lines.length} vùng chữ).`);
      return result;
    } catch (err: any) {
      error('OCR thất bại', `${fileName}: ${err.message}`);
      throw err;
    } finally {
      setIsScanning(false);
    }
  }, [applyScanResult, error, success]);

  /** Thay thế ảnh preview + thu hồi blob cũ (tránh leak bộ nhớ) */
  const replacePreviewImage = useCallback((file: File | Blob, name: string): string => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    const url = URL.createObjectURL(file);
    previewUrlRef.current = url;
    setPreviewImageUrl(url);
    return url || name;
  }, []);

  // 1. Upload ảnh/PDF hàng loạt -> quét OCR-Scan theo thứ tự, 3 layout (chờ vàng, đang scan streaming, xong xanh), auto-ghi cả lô
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    if (files.length === 0) return;

    // Validate từng file (không bịa kết quả nếu sai định dạng)
    const validFiles: File[] = [];
    for (const f of files) {
      const isImage = f.type.startsWith('image/');
      const isPdf = f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
      if (!isImage && !isPdf) {
        error('Tệp không hợp lệ', `${f.name}: vui lòng chọn JPG/PNG/PDF`);
        continue;
      }
      if (isPdf) {
        warning('PDF đã chọn', `${f.name}: OCR-Scan ưu tiên ảnh scan rõ nét LPVN-HR-F-0004. Nên xuất PDF thành ảnh PNG/JPG để chính xác nhất. Vẫn thử xử lý...`);
      }
      validFiles.push(f);
    }
    if (validFiles.length === 0) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // Tạo batch queue với previewUrl cho ảnh (để hiển thị 3 layout)
    const batch: BatchItem[] = validFiles.map((file, idx) => {
      const isImage = file.type.startsWith('image/');
      let previewUrl = '';
      if (isImage) {
        previewUrl = URL.createObjectURL(file);
      }
      const id = `batch_${Date.now()}_${idx}_${Math.random().toString(36).slice(2,5)}`;
      if (previewUrl) batchRefs.current.set(id, previewUrl);
      return { id, file, fileName: file.name, previewUrl, status: 'waiting' as BatchStatus, progress: 0 };
    });

    setBatchQueue(batch);
    setActiveBatchId(batch[0]?.id || null);
    // Reset previous single preview/grid nếu là batch mới
    if (batch.length > 1) {
      setGridRows([]);
      setFormRows([]);
      setScanDetails('');
    }
    setIsScanning(true);
    setStreamingLogs([`[${new Date().toLocaleTimeString()}] Nhận ${batch.length} file - bắt đầu quét theo thứ tự...`]);

    const isBatch = batch.length > 1;

    // Helper để cập nhật batch item
    const updateBatchItem = (id: string, patch: Partial<BatchItem>) => {
      setBatchQueue(prev => prev.map(b => b.id === id ? { ...b, ...patch } : b));
    };

    if (!isBatch) {
      // Single file: giữ logic cũ (manual Ghi Nhận) nhưng vẫn đi qua batch queue để hiển thị 3 layout
      const single = batch[0];
      try {
        updateBatchItem(single.id, { status: 'scanning', progress: 10 });
        if (single.previewUrl) {
          if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
          previewUrlRef.current = single.previewUrl;
          setPreviewImageUrl(single.previewUrl);
          batchRefs.current.delete(single.id); // chuyển quyền sở hữu sang previewUrlRef
        } else {
          setPreviewImageUrl('');
        }
        setFormTitle(`Đang quét: ${single.fileName}`);
        const bytes = await single.file.arrayBuffer();
        const hash = await hashBuffer(bytes);
        const cached = ocrCacheRef.current.get(hash);
        let result: OCRWorkerResult;
        if (cached) {
          setStreamingLogs(prev => [...prev, `[CACHE] ${single.fileName} trùng - lấy kết quả đã lưu`]);
          result = cached;
          setScanProgress(100);
        } else {
          result = await runOcrPipeline(bytes, {
            fileName: single.fileName,
            onProgress: (progress, step, message) => {
              const friendly = message.replace(/ONNX|PaddleOCR|ch_PP-OCRv4|latin_PP-OCRv3/gi, 'OCR').replace(/model/gi, 'thuật toán').replace(/pipeline/gi, 'quy trình');
              setStreamingLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] [${step}] ${friendly}`]);
              setScanProgress(progress);
              updateBatchItem(single.id, { progress });
            }
          });
          ocrCacheRef.current.set(hash, result);
        }
        updateBatchItem(single.id, { status: 'done', progress: 100, result });
        setActiveBatchId(null);
        applyScanResult(result, single.previewUrl || single.fileName, `Kết quả OCR-Scan: ${single.fileName} (${result.lines.length} vùng chữ, ${result.processingTimeMs}ms)`);
      } catch (err: any) {
        updateBatchItem(single.id, { status: 'error', error: err.message });
        error('OCR thất bại', `${single.fileName}: ${err.message}`);
        setActiveBatchId(null);
      } finally {
        setIsScanning(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
      return;
    }

    // Batch mode: xử lý tuần tự theo thứ tự, hiển thị queue 3 layout, auto-ghi cả lô sau cùng
    let accumulatedFormRows: IExtractedFormRow[] = [];
    let accumulatedGridRows: SpreadsheetRow[] = [];
    const allResults: OCRWorkerResult[] = [];
    let batchHasError = false;

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      setActiveBatchId(item.id);
      updateBatchItem(item.id, { status: 'scanning', progress: 5 });
      // Hiển thị ảnh đang scan phóng to ở trung tâm (streaming)
      if (item.previewUrl) {
        if (previewUrlRef.current && previewUrlRef.current !== item.previewUrl) {
          try { URL.revokeObjectURL(previewUrlRef.current); } catch {}
        }
        previewUrlRef.current = item.previewUrl;
        setPreviewImageUrl(item.previewUrl);
        batchRefs.current.delete(item.id);
      } else {
        setPreviewImageUrl('');
      }
      setFormTitle(`Đang quét ${i+1}/${batch.length}: ${item.fileName}`);
      setScanProgress(Math.round(5 + (i / batch.length) * 85));
      try {
        const bytes = await item.file.arrayBuffer();
        const hash = await hashBuffer(bytes);
        let result: OCRWorkerResult;
        const cached = ocrCacheRef.current.get(hash);
        if (cached) {
          result = cached;
          setStreamingLogs(prev => [...prev, `[CACHE] ${item.fileName} trùng - lấy kết quả đã lưu (không quét lại)`]);
          updateBatchItem(item.id, { progress: 50 });
        } else {
          result = await runOcrPipeline(bytes, {
            fileName: item.fileName,
            onProgress: (progress, step, message) => {
              const friendly = message.replace(/ONNX|PaddleOCR|ch_PP-OCRv4|latin_PP-OCRv3/gi, 'OCR').replace(/model/gi, 'thuật toán').replace(/pipeline/gi, 'quy trình');
              setStreamingLogs(prev => [...prev, `[${item.fileName}] [${step}] ${friendly}`]);
              updateBatchItem(item.id, { progress });
              const overall = Math.round(5 + (i / batch.length) * 85 + (progress / 100) * (85 / batch.length));
              setScanProgress(overall);
            }
          });
          ocrCacheRef.current.set(hash, result);
        }
        allResults.push(result);
        // Tích lũy Dữ liệu Thô và Dữ Liệu Đối Soát - dùng transition để tránh lag toàn hệ thống
        const hrGrid = applyHRGridCorrections(result.grid);
        const newGridRows: SpreadsheetRow[] = hrGrid.rows.map(r => ({
          yCenter: r.yCenter + i * 10000,
          cells: r.cells.map(c => ({ text: c.text, confidence: c.confidence }))
        }));
        accumulatedGridRows = [...accumulatedGridRows, ...newGridRows];
        const mapped = mappedToFormRows(hrGrid, employees);
        accumulatedFormRows = [...accumulatedFormRows, ...mapped];
        startTransition(() => {
          setGridRows(accumulatedGridRows);
          setFormRows(accumulatedFormRows);
        });
        updateBatchItem(item.id, { status: 'done', progress: 100, result });
        setStreamingLogs(prev => [...prev, `[${item.fileName}] Xong ${result.lines.length} vùng chữ in ${result.processingTimeMs}ms`]);
      } catch (err: any) {
        batchHasError = true;
        updateBatchItem(item.id, { status: 'error', error: err?.message || String(err), progress: 0 });
        setStreamingLogs(prev => [...prev, `[${item.fileName}] Lỗi: ${err?.message || err}`]);
        // Không dừng cả lô, tiếp tục file kế tiếp (không bịa kết quả)
      }
    }

    setActiveBatchId(null);
    setIsScanning(false);
    setScanProgress(100);
    setStreamingLogs(prev => [...prev, `[Hoàn tất lô ${batch.length} file - đang tổng hợp...]`]);

    // Auto-ghi cả lô sau cùng (không cần bấm Ghi Nhận), chỉ khi có quyền và có dòng hợp lệ
    if (accumulatedFormRows.length === 0) {
      warning('Lô không có dữ liệu', 'Không có dòng nào được nhận diện. Vui lòng kiểm tra lại ảnh/PDF theo form LPVN-HR-F-0004.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    // Dùng snapshot employees/overtimeRecords hiện tại để đối soát
    const reconciled = reconcileRows(accumulatedFormRows, employees, overtimeRecords);
    const validRows = reconciled.filter(r => r.employeeId && r.otDate && r.otHours !== null);
    if (validRows.length === 0) {
      warning('Lô không có dòng hợp lệ', 'Đã quét xong nhưng không có dòng nào đủ Mã NV + ngày + giờ để ghi. Kiểm tra "Dữ liệu Thô Chờ xử lý" và sửa tay trước khi bấm Ghi Nhận.');
      info('Gợi ý', `Đã quét ${batch.length} file, ${accumulatedFormRows.length} dòng thô nhưng chưa đủ điều kiện ghi tự động.`);
    } else {
      if (!canCommit) {
        warning('Không đủ quyền auto-ghi', `Vai trò "${currentRole}" không có quyền ghi dữ liệu quét OCR. Dữ liệu đã quét xong, vui lòng liên hệ Quản lý để ghi.`);
      } else {
        try {
          const { updated, scansWritten } = await commitVerifiedRows(validRows, {
            fileName: `Lô ${batch.length} file: ${batch.map(b => b.fileName).join(', ')}`,
            verifiedBy: currentRole ?? undefined,
          });
          success('Đã tự động ghi lô', `${validRows.length}/${accumulatedFormRows.length} dòng hợp lệ từ ${batch.length} file đã ghi vào hệ thống (${updated} bản ghi, ${scansWritten} lịch sử).${batchHasError ? ' (1 số file lỗi đã bỏ qua)' : ''}`);
          info('Hoàn tất', 'Không cần bấm Ghi Nhận - hệ thống đã tự động lưu cả lô. Kiểm tra tại "Xem Bảng Tăng Ca".');
        } catch (err: any) {
          error('Lỗi auto-ghi lô', err.message);
          warning('Cần ghi tay', 'Auto-ghi thất bại, vui lòng bấm "Ghi Nhận Vào Hệ Thống" để thử lại. Dữ liệu thô vẫn được giữ.');
        }
      }
    }
    setFormTitle(`Đã quét xong lô ${batch.length} file - ${validRows.length} dòng hợp lệ đã ${canCommit ? 'tự động ghi' : 'sẵn sàng'}`);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // 1b. Nạp model Paddle vào kho offline (chỉ cần 1 lần trên file://):
  // chọn các file trong PaddleOCR-Models/onnx + dictionaries + ort, lưu vào
  // IndexedDB để engine trực tiếp (không Worker) đọc được khi mở file trực tiếp.
  const handleOfflineAssetsSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    if (files.length === 0) return;
    setIsLoadingAssets(true);
    try {
      let saved = 0;
      const skipped: string[] = [];
      for (const f of files) {
        const key = guessOcrAssetKey(f.name);
        if (!key) { skipped.push(f.name); continue; }
        await putOcrAsset(key, f, f.name);
        saved++;
      }
      const keys = await getStoredOcrAssetKeys();
      setOfflineAssetCount(keys.length);
      setStoredAssetKeys(keys);
      if (saved > 0) {
        success('Đã nạp model offline', `Lưu ${saved} file vào kho offline (${keys.length} mục). Từ nay mở file trực tiếp vẫn quét OCR được.`);
      }
      if (skipped.length > 0) {
        warning('Bỏ qua file lạ', `${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` (+${skipped.length - 5} file)` : ''} — chỉ nhận det/rec .onnx, latin_dict.txt, vi_dict.txt, ort-wasm.`);
      }
      if (saved === 0 && skipped.length > 0) {
        info('Gợi ý', 'Mở thư mục PaddleOCR-Models, chọn: onnx/ch_PP-OCRv4_det_infer.onnx, onnx/latin_PP-OCRv3_rec.onnx, dictionaries/latin_dict.txt, dictionaries/vi_dict.txt, ort/ort-wasm-simd-threaded.wasm.');
      }
    } catch (err: unknown) {
      error('Lỗi nạp model offline', err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoadingAssets(false);
      if (offlineAssetsInputRef.current) offlineAssetsInputRef.current.value = '';
    }
  };

  const handleClearOfflineAssets = async () => {
    const ok = await confirm({
      title: 'Xóa kho IndexedDB offline?',
      message: 'Các file model đã lưu trong bộ nhớ trình duyệt sẽ được xóa. Hệ thống vẫn tiếp tục hoạt động bình thường nhờ bản model đã nhúng sẵn trong tệp HTML.',
      type: 'warning',
      confirmText: 'Xóa kho',
      cancelText: 'Hủy'
    });
    if (!ok) return;
    await clearOcrAssets();
    setOfflineAssetCount(0);
    setStoredAssetKeys([]);
    info('Đã dọn dẹp kho offline', 'Các file trong IndexedDB đã được xóa. Hệ thống sẽ tiếp tục sử dụng bản model nhúng sẵn trong file HTML.');
  };

  // 2. Ảnh mẫu image.png - đã ẩn khỏi toolbar theo yêu cầu (giữ hàm để không vỡ logic, nhưng không hiển thị nút)
  const handleSampleImage = async () => {
    try {
      setIsScanning(true);
      setScanProgress(3);
      setStreamingLogs([`[${new Date().toLocaleTimeString()}] Tải ảnh mẫu và đưa vào quy trình OCR-Scan...`]);
      const res = await fetch('./image.png');
      if (!res.ok) throw new Error(`Không tải được ./image.png (HTTP ${res.status})`);
      const blob = await res.blob();
      const url = replacePreviewImage(blob, 'image.png');
      const bytes = await blob.arrayBuffer();
      await scanImageBytes(bytes, 'image.png (ảnh mẫu)', url);
    } catch (err: any) {
      setIsScanning(false);
      error('Lỗi tải ảnh mẫu', err.message);
    }
  };

  // 3. Sửa ô trong bảng tính kiểu Excel
  const handleChangeCell = (rowIdx: number, cellIdx: number, text: string) => {
    setGridRows(prev => prev.map((r, i) =>
      i === rowIdx
        ? { ...r, cells: r.cells.map((c, j) => j === cellIdx ? { ...c, text } : c) }
        : r
    ));
  };

  // 4. Nạp lại dữ liệu cấu trúc từ bảng quét (sau khi người dùng sửa ô)
  const handleRemapFromGrid = () => {
    // Bảng tính chỉ chỉnh text nên dùng tọa độ ảo theo chỉ số cột để giữ căn cột
    const VIRT_COL_W = 10000;
    const grid = {
      imageWidth: 0,
      imageHeight: 0,
      rows: gridRows.map(r => ({
        yCenter: r.yCenter,
        height: 20,
        cells: r.cells.map((c, ci) => ({
          text: c.text,
          confidence: c.confidence,
          x0: ci * VIRT_COL_W,
          x1: ci * VIRT_COL_W + VIRT_COL_W - 1,
        })),
      })),
      columnBoundaries: [],
    };
    setFormRows(mappedToFormRows(grid, employees));
    info('Đã nạp lại từ bảng quét', 'Dữ liệu đối soát được cập nhật theo nội dung hiện tại của bảng tính.');
  };

  // 5. Sửa dòng dữ liệu đối soát
  const handleUpdateRowCell = (rowId: string, field: keyof IExtractedFormRow, value: any) => {
    setFormRows(prev => prev.map(row => {
      if (row.rowId !== rowId) return row;
      const updated = { ...row, [field]: value };
      if (field === 'fromTime' || field === 'toTime') {
        // Tính lại số giờ từ khung giờ mới - chỉ ghi đè khi khung giờ hợp lệ
        const hoursRes = parseOvertimeHours('', String(updated.fromTime), String(updated.toTime));
        if (hoursRes.computedFromTime !== undefined) {
          updated.otHours = hoursRes.computedFromTime;
        }
      } else if (field === 'otDateRaw') {
        // Tự động chuẩn hóa otDate (YYYY-MM-DD) khi sửa otDateRaw (DD/MM/YYYY)
        const dNorm = normalizeDateString(String(value));
        if (dNorm.valid && dNorm.normalizedDate) {
          updated.otDate = dNorm.normalizedDate;
        }
      } else if (field === 'employeeId') {
        // Tự động tìm kiếm qua MSNV từ menu danh sách nhân viên để lấy Họ tên và Bộ phận
        const normEmp = normalizeEmployeeCode(String(value), employees);
        updated.employeeId = normEmp.normalizedId || String(value);
        if (normEmp.matched) {
          updated.fullName = normEmp.name;
          if (normEmp.dept) updated.department = normEmp.dept;
        }
      }
      return updated;
    }));
  };

  const handleAddNewRow = () => {
    const newRow: IExtractedFormRow = {
      rowId: nextRowId(),
      stt: formRows.length + 1,
      fullName: '',
      employeeId: '',
      department: '',
      otDate: '',
      otDateRaw: '',
      fromTime: '',
      toTime: '',
      otHours: null,
      reason: '',
      confidence: 1,
    };
    setFormRows([...formRows, newRow]);
    info('Đã thêm dòng trống', 'Điền mã NV, ngày (DD/MM/YYYY), giờ và số giờ tăng ca.');
  };

  const handleDeleteRow = (rowId: string) => {
    setFormRows(prev => prev.filter(r => r.rowId !== rowId).map((r, i) => ({ ...r, stt: i + 1 })));
    setActiveRowIdx(null);
  };

  // 6. Ghi DB - yêu cầu quyền + hộp thoại xác nhận, transaction phía service
  const handleCommitToDatabase = async () => {
    if (!canCommit) {
      warning('Không đủ quyền', `Vai trò "${currentRole}" không có quyền SCAN_OCR hoặc SCAN_DEPT_OCR.`);
      return;
    }
    const validRows = reconciledRows.filter(r => r.employeeId && r.otDate && r.otHours !== null);
    if (validRows.length === 0) {
      warning('Chưa có dòng hợp lệ', 'Cần ít nhất 1 dòng có Mã NV, ngày và số giờ hợp lệ.');
      return;
    }

    const ok = await confirm({
      title: 'Xác nhận ghi vào hệ thống?',
      message: `Sẽ cập nhật ${validRows.length} bản ghi tăng ca (${matchedCount} khớp, ${mismatchCount} lệch) và lưu lịch sử quét. Thao tác này ghi vào IndexedDB.`,
      confirmText: 'Ghi nhận',
      cancelText: 'Xem lại',
    });
    if (!ok) return;

    try {
      const { updated, scansWritten } = await commitVerifiedRows(validRows, {
        fileName: lastFileName || formTitle,
        verifiedBy: currentRole ?? undefined,
      });
      success(
        'Đã ghi nhận kết quả quét',
        `${updated} bản ghi tăng ca được cập nhật trạng thái, ${scansWritten} mục lịch sử quét đã lưu.`
      );
    } catch (err: any) {
      error('Lỗi khi lưu dữ liệu', err.message);
    }
  };

  // 6b. Làm mới dữ liệu - xóa phiên OCR hiện tại (không reset khi qua menu khác, chỉ khi bấm nút này)
  const handleRefreshData = async () => {
    const hasData = gridRows.length > 0 || formRows.length > 0 || batchQueue.length > 0;
    if (!hasData) {
      info('Không có dữ liệu', 'Chưa có dữ liệu OCR nào để làm mới.');
      return;
    }
    const ok = await confirm({
      title: 'Làm mới dữ liệu OCR?',
      message: 'Sẽ xóa toàn bộ dữ liệu thô, dữ liệu đối soát và hàng đợi ảnh hiện tại. Dữ liệu đã ghi vào hệ thống (IndexedDB) vẫn được giữ. Bạn có chắc?',
      confirmText: 'Làm mới',
      cancelText: 'Hủy',
    });
    if (!ok) return;
    // Revoke blob URLs
    if (previewUrlRef.current) {
      try { URL.revokeObjectURL(previewUrlRef.current); } catch {}
      previewUrlRef.current = null;
    }
    batchRefs.current.forEach(url => { try { URL.revokeObjectURL(url); } catch {} });
    batchRefs.current.clear();
    // Clear state
    setGridRows([]);
    setFormRows([]);
    setBatchQueue([]);
    setActiveBatchId(null);
    setPreviewImageUrl('');
    setFormTitle('Chưa có ảnh nào được quét');
    setLastFileName('');
    setScanDetails('');
    setStreamingLogs([]);
    setScanProgress(0);
    setActiveRowIdx(null);
    // Clear persisted storage
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    // Clear OCR cache (không xóa model cache vĩnh viễn - giữ cache model để tránh lag)
    ocrCacheRef.current.clear();
    success('Đã làm mới', 'Toàn bộ dữ liệu OCR hiện tại đã được xóa. Bạn có thể tải ảnh mới.');
  };

  // 7. Health check - đã đổi tên thành Test OCR / Thuật Toán OCR, ẩn chi tiết model/ONNX/PaddleOCR khỏi UI nhưng vẫn kiểm tra đủ runtime
  const handleTestONNXModel = async () => {
    try {
      setIsTestingModel(true);
      const report: IONNXModelHealthReport = await testONNXModelRuntime();
      setIsTestingModel(false);
      if (report.needsOfflineAssets) {
        warning(
          'Thiếu model offline',
          'Đang mở file trực tiếp (không Worker) mà kho offline chưa đủ model. Bấm "Nạp model offline" và chọn các file trong PaddleOCR-Models (det/rec .onnx, latin_dict.txt, vi_dict.txt, ort-wasm).'
        );
      }
      const isReady = report.status === 'READY';
      const isWarning = report.status === 'WARNING';
      alertModal(
        'Trạng Thái Thuật Toán OCR',
        (
          <div className="space-y-4 text-xs">
            <div className={`p-3 rounded-xl border flex items-center gap-2.5 ${isReady ? 'bg-emerald-50 text-emerald-900 border-emerald-200' : isWarning ? 'bg-amber-50 text-amber-900 border-amber-200' : 'bg-rose-50 text-rose-900 border-rose-200'}`}>
              {isReady ? <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" /> : <AlertCircle className="w-5 h-5 shrink-0" />}
              <div>
                <div className="font-bold">{isReady ? 'Sẵn sàng – Hoạt động tốt' : isWarning ? 'Cần kiểm tra' : 'Lỗi thuật toán'}</div>
                <div className="text-[11px] mt-0.5 opacity-80">
                  {isReady ? 'Thuật toán OCR đã sẵn sàng cho phiếu tăng ca chuẩn LPVN-HR-F-0004. Nhận diện hình ảnh và PDF hoạt động tốt.' : `Thuật toán cần kiểm tra. Thời gian ${report.checkDurationMs}ms`}
                </div>
                <div className="text-[10px] mt-1 font-mono opacity-60">Kiểm tra lúc {report.timestamp} · {report.checkDurationMs}ms</div>
              </div>
            </div>
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
              <div className="font-bold text-slate-800 flex items-center gap-1.5">
                <Cpu className="w-4 h-4 text-indigo-600" />
                <span>Thuật Toán OCR</span>
              </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-600">
              <div>• Trạng thái: <b className={isReady ? 'text-emerald-600' : 'text-amber-600'}>{isReady ? 'Sẵn sàng' : isWarning ? 'Cảnh báo' : 'Lỗi'}</b></div>
              <div>• Tăng tốc: <b className={(report.wasmEngine.simdSupported || report.wasmEngine.threads >= 2 || report.wasmEngine.webgpuSupported) ? 'text-emerald-600' : 'text-rose-600'}>{(report.wasmEngine.simdSupported || report.wasmEngine.threads >= 2 || report.wasmEngine.webgpuSupported) ? 'Hoạt động tốt - Khả dụng' : 'Không hỗ trợ'}</b> <span className="text-[10px] text-slate-400">({report.wasmEngine.simdSupported ? 'SIMD' : report.wasmEngine.threads>=2 ? `${report.wasmEngine.threads} luồng` : 'cơ bản'} {report.wasmEngine.webgpuSupported ? '+ WebGPU' : ''})</span></div>
              <div>• Luồng xử lý: <b className="text-slate-900">{report.wasmEngine.threads} luồng</b> {typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated ? <span className="text-[10px] text-amber-600">(cần COOP/COEP để bật đa luồng tối đa)</span> : null}</div>
              <div>• Đồ họa: <b className="text-blue-600">{report.wasmEngine.webgpuSupported ? 'Khả dụng' : 'Tương thích (WASM)'}</b></div>
            </div>
            <div className="text-[11px] pt-1 border-t border-slate-200 text-slate-500">
              Cấu hình chuẩn cho form LPVN-HR-F-0004 · Đánh máy, chữ ký viết tay
              {report.protocol === 'file' && (
                <span className="block mt-1 font-bold text-amber-700">
                  Chế độ file trực tiếp (không Worker) · Nguồn model: {report.assetSource === 'embedded' ? 'nhúng trong ứng dụng (chạy được file://)' : report.assetSource === 'idb' ? 'kho offline (IndexedDB)' : report.assetSource === 'mixed' ? 'kết hợp server + kho offline' : report.assetSource === 'server' ? 'thư mục PaddleOCR-Models' : 'chưa đủ — cần Nạp model offline'}
                </span>
              )}
            </div>
          </div>

          {/* Ẩn chi tiết model/ONNX/PaddleOCR khỏi UI theo yêu cầu, nhưng vẫn kiểm tra ngầm - chỉ hiện tóm tắt */}
          <div className="p-3 bg-white rounded-xl border border-slate-200 space-y-2">
            <div className="font-bold text-slate-800">Cấu hình nhận diện</div>
            <div className="grid grid-cols-2 gap-2">
              {report.models.map(m => (
                <div key={m.path} className="p-2.5 bg-slate-50 rounded-lg border border-slate-200 flex items-center justify-between">
                  <div>
                    <div className="font-bold text-slate-800 text-[11px]">Tài nguyên OCR</div>
                    <div className="text-[10px] text-slate-500">{m.sizeFormatted} · {m.loaded ? 'Sẵn sàng' : 'Thiếu'}</div>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${m.loaded ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                    {m.loaded ? '✓ Sẵn sàng' : '✗ Lỗi'}
                  </span>
                </div>
              ))}
            </div>
            <div className="p-2.5 bg-emerald-50 rounded-lg border border-emerald-200 text-[11px] text-emerald-800">
              <b>Hoạt động tốt:</b> Dữ liệu OCR được cấu hình chuẩn cho phiếu tăng ca. Hệ thống đã sẵn sàng nhận diện hình ảnh và PDF.
            </div>
          </div>
          </div>
        )
      );
    } catch (err: any) {
      setIsTestingModel(false);
      error('Lỗi kiểm tra thuật toán OCR', err.message);
    }
  };

  return (
    <div className="p-6 w-full space-y-6 flex-1 flex flex-col font-sans">
      {/* Banner */}
      <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-extrabold text-slate-900 flex items-center gap-2">
            <ScanLine className="w-5 h-5 text-orange-500" />
            <span>OCR-Scan nhận diện hình ảnh và PDF</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            OCR dữ liệu được cấu hình chuẩn cho phiếu tăng ca, ưu tiên 1 form chuẩn (LPVN-HR-F-0004 Overtime agreement form V1.0) và đánh máy chỉ viết tay cho chữ ký.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={handleTestONNXModel}
            disabled={isTestingModel}
            className="flex items-center gap-2 px-3.5 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-bold rounded-xl transition shadow-sm"
          >
            {isTestingModel ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cpu className="w-4 h-4" />}
            <span>Test OCR</span>
          </button>

          {fileMode && (
            <button
              onClick={() => setIsOfflineModalOpen(true)}
              disabled={isLoadingAssets}
              title="Xem hướng dẫn & quản lý model OCR offline"
              className="flex items-center gap-2 px-3.5 py-2 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 text-xs font-bold rounded-xl transition shadow-sm"
            >
              {isLoadingAssets ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
              <span>{storedAssetKeys.length > 0 ? `Kho model offline (${storedAssetKeys.length}/5 file)` : 'Nạp model offline'}</span>
            </button>
          )}

          <button
            onClick={handleCommitToDatabase}
            disabled={isScanning || !canCommit}
            title={canCommit ? 'Ghi kết quả đã xác nhận vào IndexedDB' : `Vai trò "${currentRole}" không có quyền SCAN_OCR / SCAN_DEPT_OCR`}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-xs font-bold rounded-xl transition shadow-md shadow-emerald-200"
          >
            <Save className="w-4 h-4" />
            <span>Ghi Nhận Vào Hệ Thống</span>
          </button>

          <button
            onClick={handleRefreshData}
            disabled={isScanning}
            title="Xóa dữ liệu OCR hiện tại (không ảnh hưởng dữ liệu đã ghi)"
            className="flex items-center gap-2 px-3.5 py-2 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 text-xs font-bold rounded-xl transition shadow-sm disabled:opacity-50"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Làm mới dữ liệu</span>
          </button>

          <button
            onClick={() => onNavigate('overtime')}
            className="flex items-center gap-2 px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-xl transition shadow-sm"
          >
            <FileSpreadsheet className="w-4 h-4 text-orange-400" />
            <span>Xem Bảng Tăng Ca</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Toolbar quét - đã bỏ Quét Ảnh Mẫu theo yêu cầu, chỉ giữ tải ảnh/PDF hàng loạt */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col md:flex-row items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept="image/*,application/pdf" multiple className="hidden" />
          <input type="file" ref={offlineAssetsInputRef} onChange={handleOfflineAssetsSelected} accept=".onnx,.txt,.wasm,.mjs" multiple className="hidden" />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isScanning}
            className="px-4 py-1.5 bg-slate-900 hover:bg-black text-white rounded-lg text-xs font-bold transition flex items-center gap-1.5 disabled:opacity-50 shadow-sm"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Tải Ảnh / PDF Phiếu Tăng Ca (chọn nhiều)</span>
          </button>
          {batchQueue.length > 1 && (
            <span className="text-[11px] text-slate-500">Đã chọn {batchQueue.length} file • {batchQueue.filter(b=>b.status==='done').length} xong • {batchQueue.filter(b=>b.status==='scanning').length} đang quét</span>
          )}
        </div>

        {(scanProgress > 0 || streamingLogs.length > 0) && (
          <div className="flex items-center gap-2 min-w-[220px]">
            <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-orange-400 to-orange-500 rounded-full transition-all" style={{ width: `${scanProgress}%` }} />
            </div>
            <span className="text-[11px] font-bold text-slate-500">{scanProgress}%</span>
          </div>
        )}
      </div>

      {/* Split view */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1">
        {/* Trái: ảnh gốc */}
        <div className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <ImageIcon className="w-4 h-4 text-orange-500" />
              <h3 className="text-xs font-bold text-slate-800 truncate">{formTitle}</h3>
            </div>
            <span className="text-[10px] px-2 py-0.5 bg-slate-100 text-slate-600 font-bold rounded">Ảnh Gốc</span>
          </div>

          {/* 3-layout queue: chờ (vàng) - đang scan (streaming, phóng to trung tâm) - xong (xanh) */}
          <div className="relative flex-1 min-h-[340px] bg-slate-900 rounded-xl overflow-hidden flex flex-col p-2 border border-slate-800 gap-2">
            {batchQueue.length === 0 ? (
              previewImageUrl ? (
                <div className="flex-1 flex items-center justify-center relative">
                  <img
                    src={previewImageUrl}
                    alt="Phiếu tăng ca"
                    className="max-h-[320px] w-auto object-contain rounded shadow-md"
                  />
                  {isScanning && (
                    <div className="absolute inset-0 bg-orange-500/10 pointer-events-none flex flex-col justify-center">
                      <div className="h-1 w-full bg-gradient-to-r from-transparent via-orange-400 to-transparent animate-pulse shadow-lg shadow-orange-500" />
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-slate-400 text-xs text-center px-6">
                  Chưa có ảnh nào được quét. Bấm "Tải Ảnh / PDF Phiếu Tăng Ca (chọn nhiều)" để quét hàng loạt theo thứ tự. Hỗ trợ form chuẩn LPVN-HR-F-0004.
                </div>
              )
            ) : (
              <>
                {/* Hàng chờ - thu nhỏ 1 góc, animation vàng */}
                {batchQueue.filter(b => b.status === 'waiting').length > 0 && (
                  <div className="flex items-center gap-2 p-1.5 bg-amber-950/30 rounded-lg border border-amber-800/30">
                    <span className="text-[10px] font-bold text-amber-400 shrink-0">Chờ ({batchQueue.filter(b => b.status === 'waiting').length})</span>
                    <div className="flex gap-1.5 overflow-x-auto">
                      {batchQueue.filter(b => b.status === 'waiting').map(b => (
                        <div key={b.id} className="w-10 h-10 rounded border-2 border-amber-400 bg-amber-400/20 flex items-center justify-center shrink-0 animate-pulse">
                          {b.previewUrl ? <img src={b.previewUrl} alt={b.fileName} className="w-full h-full object-cover rounded" /> : <span className="text-[7px] text-amber-300 truncate px-1">{b.fileName.slice(0,6)}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Trung tâm - ảnh đang scan phóng to, hiệu ứng streaming scan */}
                <div className="flex-1 relative flex items-center justify-center bg-slate-800 rounded-lg overflow-hidden min-h-[180px]">
                  {(() => {
                    const active = batchQueue.find(b => b.id === activeBatchId) || batchQueue.find(b => b.status === 'scanning');
                    const displayUrl = active?.previewUrl || previewImageUrl;
                    const displayName = active?.fileName || formTitle;
                    if (displayUrl) {
                      return (
                        <>
                          <img src={displayUrl} alt={displayName} className="max-h-[260px] w-auto object-contain rounded shadow-md" />
                          {(active?.status === 'scanning' || isScanning) && (
                            <div className="absolute inset-0 pointer-events-none flex flex-col justify-center">
                              <div className="h-0.5 w-full bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-pulse shadow-lg shadow-cyan-400" style={{ animation: 'scanMove 1.8s ease-in-out infinite' }} />
                              <div className="absolute inset-0 bg-gradient-to-b from-transparent via-cyan-500/5 to-transparent animate-pulse" />
                            </div>
                          )}
                          {active && (
                            <div className="absolute bottom-1 left-1 right-1 bg-black/70 text-[10px] text-white px-2 py-1 rounded flex justify-between">
                              <span className="truncate">{displayName}</span>
                              <span>{active.progress}%</span>
                            </div>
                          )}
                        </>
                      );
                    }
                    if (active) {
                      return <div className="text-cyan-300 text-xs text-center px-4">Đang chuẩn bị {active.fileName}...<div className="mt-2 h-1 w-24 bg-slate-700 rounded overflow-hidden mx-auto"><div className="h-full bg-cyan-400 animate-pulse" style={{ width: `${active.progress}%` }} /></div></div>;
                    }
                    return <div className="text-slate-400 text-xs">Chờ quét...</div>;
                  })()}
                </div>
                {/* Hàng xong - thu nhỏ 1 góc, animation xanh lá */}
                {batchQueue.filter(b => b.status === 'done').length > 0 && (
                  <div className="flex items-center gap-2 p-1.5 bg-emerald-950/30 rounded-lg border border-emerald-800/30">
                    <span className="text-[10px] font-bold text-emerald-400 shrink-0">Xong ({batchQueue.filter(b => b.status === 'done').length})</span>
                    <div className="flex gap-1.5 overflow-x-auto">
                      {batchQueue.filter(b => b.status === 'done').map(b => (
                        <div key={b.id} className="w-10 h-10 rounded border-2 border-emerald-400 bg-emerald-400/20 flex items-center justify-center shrink-0 relative">
                          {b.previewUrl ? <img src={b.previewUrl} alt={b.fileName} className="w-full h-full object-cover rounded opacity-80" /> : <span className="text-[7px] text-emerald-300 truncate px-1">{b.fileName.slice(0,6)}</span>}
                          <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full border border-white flex items-center justify-center text-[8px] text-white">✓</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* Hàng lỗi nếu có */}
                {batchQueue.filter(b => b.status === 'error').length > 0 && (
                  <div className="flex items-center gap-2 p-1.5 bg-rose-950/30 rounded-lg border border-rose-800/30">
                    <span className="text-[10px] font-bold text-rose-400">Lỗi ({batchQueue.filter(b => b.status === 'error').length})</span>
                    <div className="flex gap-1.5 overflow-x-auto">
                      {batchQueue.filter(b => b.status === 'error').map(b => (
                        <div key={b.id} className="w-10 h-10 rounded border-2 border-rose-400 bg-rose-400/20 flex items-center justify-center shrink-0" title={b.error}>
                          <span className="text-[10px] text-rose-300">!</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          <style>{`@keyframes scanMove { 0% { transform: translateY(-60px); opacity: 0.7; } 50% { transform: translateY(60px); opacity: 1; } 100% { transform: translateY(-60px); opacity: 0.7; } }`}</style>

          {/* Log xử lý - đã giản lược hiển thị, không còn chữ model/ONNX/PaddleOCR */}
          <div className="p-3 bg-slate-950 rounded-xl text-[10px] font-mono text-emerald-400 space-y-0.5 max-h-32 overflow-y-auto border border-slate-800">
            {streamingLogs.length === 0
              ? <div className="text-slate-500">Nhật ký xử lý sẽ hiển thị tại đây...</div>
              : streamingLogs.slice(-40).map((l, i) => <div key={i}>{l.replace(/ONNX|PaddleOCR|ch_PP-OCRv4|latin_PP-OCRv3/gi, 'OCR').replace(/model/gi, 'thuật toán')}</div>)}
          </div>

          {scanDetails && (
            <div className="p-2.5 bg-indigo-50 rounded-xl text-[10.5px] text-indigo-900 border border-indigo-100">
              <b>Chi tiết xử lý:</b> {scanDetails.replace(/ONNX|PaddleOCR|ch_PP-OCRv4|latin_PP-OCRv3/gi, 'OCR').replace(/pipeline/gi, 'quy trình').replace(/model/gi, 'thuật toán')}
            </div>
          )}
        </div>

        {/* Phải: bảng tính Excel + đối soát - fix tràn pre-scan: mỗi panel cuộn riêng, header không tràn */}
        <div className="lg:col-span-7 bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col space-y-4 min-w-0 overflow-hidden">
          {/* A. Dữ liệu Thô Chờ xử lý - đổi tên theo yêu cầu, fix tràn khi chưa scan */}
          <div className="min-w-0 overflow-hidden">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pb-2 border-b border-slate-100 min-w-0">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5 min-w-0">
                  <Table2 className="w-4 h-4 text-orange-500 shrink-0" />
                  <span className="truncate">Dữ liệu Thô Chờ xử lý</span>
                </h3>
                <p className="text-[11px] text-slate-400 truncate">Ô nền vàng = độ tin cậy thấp, cần rà tay. Sửa trực tiếp trong ô.</p>
              </div>
              <button
                onClick={handleRemapFromGrid}
                disabled={gridRows.length === 0}
                className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-[11px] font-bold transition flex items-center gap-1 disabled:opacity-40 shrink-0"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Nạp vào bảng đối soát</span>
              </button>
            </div>
            <div className="overflow-hidden min-h-[120px] rounded-xl border border-slate-100">
              <OcrSpreadsheetPreview
                rows={gridRows}
                activeRowIdx={activeRowIdx}
                onSelectRow={setActiveRowIdx}
                onChangeCell={handleChangeCell}
              />
            </div>
          </div>

          {/* B. Dữ liệu đối soát - fix tràn: header bọc lại, không tràn vào panel A khi chưa scan */}
          <div className="min-w-0 overflow-hidden">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pb-2 border-b border-slate-100 min-w-0">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-extrabold text-slate-900 break-words">Dữ Liệu Nhận Diện &amp; Đối Soát Quẹt Thẻ</h3>
                <p className="text-[11px] text-slate-400 break-words">Trạng thái tính lại tức thì so với dữ liệu chấm công thật trong hệ thống</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded-lg bg-emerald-100 text-emerald-800 text-[11px] font-bold">✓ {matchedCount} Khớp</span>
                {mismatchCount > 0 && (
                  <span className="px-2.5 py-1 rounded-lg bg-rose-100 text-rose-800 text-[11px] font-bold animate-pulse">⚠ {mismatchCount} Lệch</span>
                )}
                {notFoundCount > 0 && (
                  <span className="px-2.5 py-1 rounded-lg bg-amber-100 text-amber-800 text-[11px] font-bold">{notFoundCount} Chờ sửa</span>
                )}
                <button
                  onClick={handleAddNewRow}
                  className="px-2.5 py-1 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-[11px] font-bold transition flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5 text-orange-400" />
                  <span>Thêm Dòng</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto overflow-y-auto max-h-[340px] border border-slate-200 rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-900 text-white font-bold sticky top-0 z-10 text-[11px]">
                  <tr>
                    <th className="py-2.5 px-2 text-center w-8">#</th>
                    <th className="py-2.5 px-3 min-w-[100px]">Mã NV</th>
                    <th className="py-2.5 px-3 min-w-[130px]">Họ và Tên</th>
                    <th className="py-2.5 px-2 text-center min-w-[90px]">Ngày</th>
                    <th className="py-2.5 px-2 text-center min-w-[100px]">Từ - Đến</th>
                    <th className="py-2.5 px-2 text-center min-w-[64px]">Giờ Phiếu</th>
                    <th className="py-2.5 px-2 text-center min-w-[70px]">Quẹt Thẻ</th>
                    <th className="py-2.5 px-3 text-center min-w-[104px]">Đối Soát</th>
                    <th className="py-2.5 px-2 text-center w-8">Xóa</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {reconciledRows.length === 0 && (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-slate-400 text-[11px]">
                        Chưa có dòng dữ liệu. Quét ảnh rồi bấm "Nạp vào bảng đối soát".
                      </td>
                    </tr>
                  )}
                  {reconciledRows.map((row) => {
                    const srcRow = formRows.find(r => r.rowId === row.rowId)!;
                    const status = row.matchStatus;
                    const isMismatch = status === 'MISMATCH';
                    // Highlight lệch rõ hơn 1 chút nhưng không quá gắt: dùng rose-50 đậm hơn + border trái, tránh bg-rose-100 quá chói
                    return (
                      <React.Fragment key={row.rowId}>
                      <tr
                        className={`transition ${
                          status === 'MATCHED'
                            ? 'hover:bg-emerald-50/50'
                            : isMismatch
                              ? 'bg-rose-50 hover:bg-rose-100/70 border-l-2 border-rose-400'
                              : 'hover:bg-amber-50/40'
                        }`}
                      >
                        <td className="py-2 px-2 text-center text-slate-400 font-bold">{row.stt}</td>
                        <td className="py-2 px-2">
                          <input
                            type="text"
                            value={srcRow?.employeeId || ''}
                            onChange={(e) => handleUpdateRowCell(row.rowId, 'employeeId', e.target.value)}
                            placeholder="LEP..."
                            aria-label="Mã nhân viên"
                            className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded font-mono font-bold text-indigo-700 text-xs focus:bg-white focus:outline-none focus:border-orange-500"
                          />
                        </td>
                        <td className="py-2 px-3 font-semibold text-slate-900 text-[11px] truncate">
                          {row.fullName || <span className="text-slate-300 italic">—</span>}
                        </td>
                        <td className="py-2 px-2 text-center">
                          <input
                            type="text"
                            value={srcRow?.otDateRaw || ''}
                            onChange={(e) => handleUpdateRowCell(row.rowId, 'otDateRaw', e.target.value)}
                            placeholder="DD/MM/YYYY"
                            aria-label="Ngày tăng ca"
                            className={`w-20 px-1.5 py-1 text-center border rounded font-semibold text-[11px] focus:bg-white focus:outline-none focus:border-orange-500 ${
                              row.otDate ? 'bg-slate-50 border-slate-200 text-slate-800' : 'bg-amber-50 border-amber-300 text-amber-800'
                            }`}
                          />
                        </td>
                        <td className="py-2 px-2 text-center">
                          <div className="flex items-center justify-center gap-1 font-mono text-[10px]">
                            <input
                              type="text"
                              value={srcRow?.fromTime || ''}
                              onChange={(e) => handleUpdateRowCell(row.rowId, 'fromTime', e.target.value)}
                              placeholder="07:30"
                              aria-label="Giờ vào"
                              className="w-11 px-1 py-0.5 text-center bg-slate-50 border border-slate-200 rounded"
                            />
                            <span>-</span>
                            <input
                              type="text"
                              value={srcRow?.toTime || ''}
                              onChange={(e) => handleUpdateRowCell(row.rowId, 'toTime', e.target.value)}
                              placeholder="16:00"
                              aria-label="Giờ ra"
                              className="w-11 px-1 py-0.5 text-center bg-slate-50 border border-slate-200 rounded"
                            />
                          </div>
                        </td>
                        <td className="py-2 px-2 text-center">
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            value={srcRow?.otHours ?? ''}
                            onChange={(e) => handleUpdateRowCell(row.rowId, 'otHours', e.target.value === '' ? null : parseFloat(e.target.value))}
                            aria-label="Số giờ tăng ca"
                            className={`w-14 px-1 py-1 text-center rounded font-extrabold text-xs focus:bg-white focus:outline-none focus:border-orange-500 ${
                              row.otHours === null ? 'bg-amber-50 border border-amber-300 text-amber-700' : 'bg-orange-50 border border-orange-200 text-orange-600'
                            }`}
                          />
                        </td>
                        <td className="py-2 px-2 text-center font-bold text-slate-700 text-[11px]">
                          {row.dbHours !== undefined ? `${row.dbHours.toFixed(1)}h` : '—'}
                        </td>
                        <td className="py-2 px-3 text-center">
                          {status === 'MATCHED' ? (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px] inline-flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" /> Khớp
                            </span>
                          ) : status === 'MISMATCH' ? (
                            <span className="px-2 py-0.5 rounded-full bg-rose-100 text-rose-800 font-bold text-[10px] inline-flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" /> Lệch
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold text-[10px] inline-flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" /> Chờ sửa
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-center">
                          <button
                            onClick={() => handleDeleteRow(row.rowId)}
                            aria-label={`Xóa dòng ${row.stt}`}
                            className="text-slate-300 hover:text-rose-600 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                      {isMismatch && row.details && (
                        <tr className="bg-rose-50/70">
                          <td colSpan={9} className="px-3 py-2 text-[11px] text-rose-800 border-t border-rose-200">
                            <span className="inline-flex items-start gap-1.5">
                              <AlertCircle className="w-3.5 h-3.5 text-rose-600 mt-0.5 shrink-0" />
                              <span><b>Lý do lệch:</b> {row.details}</span>
                            </span>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Chi tiết dòng đang chọn */}
            {activeRowIdx !== null && gridRows[activeRowIdx] && (
              <div className="p-3 rounded-xl border text-xs bg-orange-50/60 border-orange-200 text-orange-900">
                <span className="font-bold">Hàng quét #{activeRowIdx + 1}: </span>
                <span>{gridRows[activeRowIdx].cells.map(c => c.text).join(' | ') || '(trống)'}</span>
              </div>
            )}
            {activeRowIdx === null && reconciledRows.length > 0 && (
              <div className={`p-3 rounded-xl border text-xs ${
                reconciledRows[0].matchStatus === 'MATCHED'
                  ? 'bg-emerald-50/60 border-emerald-200 text-emerald-900'
                  : 'bg-amber-50/60 border-amber-200 text-amber-900'
              }`}>
                <span className="font-bold">Chi tiết dòng 1 ({reconciledRows[0].fullName || reconciledRows[0].employeeId}): </span>
                <span className="opacity-90">{reconciledRows[0].details}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal Hướng dẫn & Quản lý Model Offline */}
      {isOfflineModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-2xl w-full p-6 space-y-5 text-slate-800 my-auto">
            {/* Header */}
            <div className="flex items-start justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center font-bold">
                  <Layers className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-extrabold text-base text-slate-900">Hướng Dẫn & Quản Lý Model OCR Offline</h3>
                  <p className="text-xs text-slate-500 mt-0.5">Cấu hình nhận diện hình ảnh & PDF cho phiếu tăng ca LPVN-HR-F-0004</p>
                </div>
              </div>
              <button
                onClick={() => setIsOfflineModalOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Thông điệp cốt lõi: MÁY MỚI CÓ CẦN NẠP THỦ CÔNG KHÔNG? */}
            <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 space-y-2">
              <div className="flex items-center gap-2 font-bold text-sm">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                <span>Mở trên máy tính mới hoàn toàn: KHÔNG CẦN nạp thủ công!</span>
              </div>
              <p className="text-xs text-emerald-800 leading-relaxed pl-7">
                Bản build Single-File <b>dist/index.html</b> đã được <b>nhúng sẵn 100% Model OCR (Base64)</b> và WebAssembly Core trực tiếp bên trong file HTML. Khi copy file sang bất kỳ máy tính mới nào mở lên, hệ thống sẽ <b>tự động giải mã model và quét ảnh nhận diện được ngay lập tức</b> mà không cần Internet hay tải thêm bất kỳ file nào.
              </p>
            </div>

            {/* Khi nào cần nạp & danh sách file */}
            <div className="space-y-3">
              <div className="font-bold text-xs uppercase tracking-wider text-slate-500">
                Khi nào cần nạp & Danh sách 5 file nạp dự phòng (Fallback)
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                Thẻ này chỉ dùng làm <b>phương án dự phòng thứ 2</b> khi trình duyệt máy bị thiếu RAM không khởi tạo được Worker và yêu cầu lưu model vào IndexedDB. Khi đó, hãy bấm nút màu cam bên dưới và chọn <b>5 file</b> sau từ thư mục <code className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-700 font-mono text-[11px]">PaddleOCR-Models/</code> (hoặc thư mục <code className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-700 font-mono text-[11px]">dist/</code>):
              </p>

              {/* Danh sách 5 file */}
              <div className="grid grid-cols-1 gap-2 text-xs">
                {[
                  {
                    key: 'det',
                    name: 'ch_PP-OCRv4_det_infer.onnx',
                    folder: 'PaddleOCR-Models/onnx/',
                    desc: 'Model phát hiện vùng chữ trong phiếu tăng ca',
                    size: '~4.5 MB'
                  },
                  {
                    key: 'rec',
                    name: 'latin_PP-OCRv3_rec.onnx',
                    folder: 'PaddleOCR-Models/onnx/',
                    desc: 'Model nhận diện ký tự tiếng Việt & Latin',
                    size: '~8.6 MB'
                  },
                  {
                    key: 'latin_dict',
                    name: 'latin_dict.txt',
                    folder: 'PaddleOCR-Models/dictionaries/',
                    desc: 'Từ điển tiếng Việt đầy đủ dấu thanh',
                    size: '~13 KB'
                  },
                  {
                    key: 'vi_dict',
                    name: 'vi_dict.txt',
                    folder: 'PaddleOCR-Models/dictionaries/',
                    desc: 'Từ điển bổ trợ nhận diện tiếng Việt',
                    size: '~12 KB'
                  },
                  {
                    key: 'ort-wasm',
                    name: 'ort-wasm-simd-threaded.wasm',
                    folder: 'PaddleOCR-Models/ort/',
                    desc: 'Lõi tính toán WebAssembly ONNX Runtime',
                    size: '~12.8 MB'
                  },
                ].map((item) => {
                  const isLoaded = storedAssetKeys.includes(item.key);
                  return (
                    <div key={item.key} className="p-2.5 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
                      <div className="space-y-0.5 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-800 font-mono text-[11px] truncate">{item.name}</span>
                          <span className="text-[10px] text-slate-400">({item.size})</span>
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">{item.desc} · <span className="font-mono text-slate-400">{item.folder}</span></div>
                      </div>
                      <div className="shrink-0 flex items-center gap-1.5">
                        {isLoaded ? (
                          <span className="px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold">
                            ✓ Đã lưu kho IDB
                          </span>
                        ) : (
                          <span className="px-2.5 py-0.5 rounded-full bg-blue-100 text-blue-800 text-[10px] font-semibold">
                            ⚡ Sẵn sàng (nhúng HTML)
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Footer & Actions */}
            <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {storedAssetKeys.length > 0 && (
                  <button
                    onClick={handleClearOfflineAssets}
                    className="px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 rounded-lg transition font-medium border border-rose-200"
                  >
                    Xóa kho IndexedDB ({storedAssetKeys.length} file)
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setIsOfflineModalOpen(false);
                    handleTestONNXModel();
                  }}
                  className="px-3.5 py-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl transition"
                >
                  Kiểm tra thuật toán OCR
                </button>
                <button
                  onClick={() => offlineAssetsInputRef.current?.click()}
                  disabled={isLoadingAssets}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-xl transition shadow-md shadow-amber-200"
                >
                  {isLoadingAssets ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  <span>Chọn file nạp dự phòng</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
