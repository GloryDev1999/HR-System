/**
 * Shared message contract giữa main thread và onnx-ocr.worker.ts.
 * Chỉ chứa types (bị xoá lúc compile) nên an toàn khi import từ cả 2 phía
 * mà không kéo bundle của worker vào main thread.
 */

export interface OcrTextLine {
  /** Văn bản nhận dạng được (UTF-8, giữ dấu tiếng Việt) */
  text: string;
  /** Độ tin cậy trung bình của các frame CTC được giữ lại (0..1) */
  confidence: number;
  /** Tọa độ trên ảnh gốc */
  box: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrGridCell {
  text: string;
  confidence: number;
  /** Tọa độ hợp nhất của cell (có thể gộp nhiều box cùng ô) */
  x0: number;
  x1: number;
}

export interface OcrGridRow {
  yCenter: number;
  height: number;
  cells: OcrGridCell[];
}

/** Lưới bảng tái tạo theo bố cục ảnh scan */
export interface OcrTableGrid {
  imageWidth: number;
  imageHeight: number;
  rows: OcrGridRow[];
  /** Ranh giới cột (x trung tâm) dùng cho việc căn lưới preview kiểu Excel */
  columnBoundaries: number[];
}

export type OcrRunMode =
  | 'REAL_ONNX'
  | 'PARTIAL_ONNX'
  | 'FAILED';

export interface OCRWorkerRunPayload {
  /** Dữ liệu nhị phân ảnh (JPEG/PNG bytes) - transferable */
  imageBytes?: ArrayBuffer;
  fileName?: string;
  /** Môi trường chạy offline file:// (cần 1 luồng / wasmBinary thay vì fetch wasm ngoài) */
  isFileProtocol?: boolean;
}

export interface OCRWorkerRequest {
  type: 'RUN_OCR';
  requestId: string;
  payload: OCRWorkerRunPayload;
}

export interface OCRWorkerProgress {
  type: 'PROGRESS';
  requestId: string;
  progress: number;
  step: string;
  message: string;
}

export interface OCRWorkerResult {
  type: 'COMPLETE';
  requestId: string;
  mode: OcrRunMode;
  fileName: string;
  lines: OcrTextLine[];
  grid: OcrTableGrid;
  processingTimeMs: number;
  /** Diễn giải trung thực về các bước đã chạy thật / bỏ qua */
  details: string;
  rawText: string;
}

export interface OCRWorkerError {
  type: 'ERROR';
  requestId: string;
  error: string;
}
