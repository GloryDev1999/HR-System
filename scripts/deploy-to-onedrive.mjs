/**
 * scripts/deploy-to-onedrive.mjs — Copy dist/ sang thư mục OneDrive đích.
 *
 * update-model.md §5.2 ghi cứng username Windows trong code. Script này dùng
 * biến môi trường HR_ONEDRIVE_DIST để portable giữa các máy:
 *   PowerShell: $env:HR_ONEDRIVE_DIST="C:\\Users\\<bạn>\\OneDrive - ...\\HR-System\\dist"
 * Nếu không đặt biến môi trường, script bỏ qua (không fail build).
 */
import { cpSync, existsSync } from 'fs';

const TARGET = process.env.HR_ONEDRIVE_DIST;
if (!TARGET) {
  console.log('[deploy-to-onedrive] Bỏ qua (chưa đặt HR_ONEDRIVE_DIST).');
  process.exit(0);
}
if (!existsSync('dist')) {
  console.error('[deploy-to-onedrive] Không tìm thấy dist/ — chạy npm run build trước.');
  process.exit(1);
}
cpSync('dist', TARGET, { recursive: true });
console.log('[deploy-to-onedrive] Đã copy build sang', TARGET);
