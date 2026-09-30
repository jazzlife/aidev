/**
 * live-window — floating overlay windows for live content in the workbench (preview, remote screen):
 * movable, resizable, maximize / minimize-to-dock, pop out into a browser window (IMPLEMENTATION-PLAN §3.11).
 */
export { LiveWindowHost } from '@/modules/live-window/LiveWindowHost';
export type { LiveWindowSpec } from '@/modules/live-window/LiveWindowHost';
export { liveWindows, useLiveWindows } from '@/modules/live-window/liveWindowStore';
