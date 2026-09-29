/**
 * remote-screen — program windows and consoles of a user's PC, live and controllable
 * (IMPLEMENTATION-PLAN §3.12, F-07b/F-07c). Shared by the workbench (ScreenPane) and the mobile app
 * (remote screen): the window stream session and input, the list of sources, and the console view.
 */
export { useRemoteScreen } from '@/modules/remote-screen/useRemoteScreen';
export { useScreenSources } from '@/modules/remote-screen/useScreenSources';
export { RemoteConsole } from '@/modules/remote-screen/RemoteConsole';
export { RemoteScreenSession, avcCodecFromAnnexB, screenSocketUrl, webCodecsAvailable } from '@/modules/remote-screen/session';
export type { InputEvent, ScreenMode, ScreenOptions, ScreenState } from '@/modules/remote-screen/session';
export { bindRemoteInput } from '@/modules/remote-screen/input';
export type { StickyMods } from '@/modules/remote-screen/input';
