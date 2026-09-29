/**
 * remote-screen — live screen and remote control of a user's PC (IMPLEMENTATION-PLAN §3.12, F-07b).
 * Non-visual core shared by the workbench (ScreenPane) and the mobile app (remote screen).
 */
export { useRemoteScreen } from '@/modules/remote-screen/useRemoteScreen';
export { RemoteScreenSession, avcCodecFromAnnexB, screenSocketUrl, webCodecsAvailable } from '@/modules/remote-screen/session';
export type { InputEvent, ScreenMode, ScreenOptions, ScreenState } from '@/modules/remote-screen/session';
export { bindRemoteInput } from '@/modules/remote-screen/input';
export type { StickyMods } from '@/modules/remote-screen/input';
