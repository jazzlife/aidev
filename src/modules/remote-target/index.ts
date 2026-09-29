/**
 * remote-target — developer PCs connected through aidev-runner (IMPLEMENTATION-PLAN §3.12, stage F).
 * Workbench UI only; the mobile app gets its own sheet.
 */
export { TargetsPanel } from '@/modules/remote-target/TargetsPanel';
export { RunOutputPane, requestRunFocus } from '@/modules/remote-target/RunOutputPane';
export { RemoteApprovalCards, ApprovalCard } from '@/modules/remote-target/RemoteApprovalCards';
export { PreviewPane, usePreviewList } from '@/modules/remote-target/PreviewPane';
export type { PreviewEntry } from '@/modules/remote-target/PreviewPane';
export { ScreenPane } from '@/modules/remote-target/ScreenPane';
