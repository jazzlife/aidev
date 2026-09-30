import { useEffect, useMemo, useState } from 'react';
import { Play } from 'lucide-react';

import { adapterFor, debugStore, defaultTargetFolder, splitArgs, toTargetPath, useDebugStore } from '@/modules/remote-debug';
import { api, debugApi, readApiJson } from '@/shared/api';
import type { RemoteDebugAdapter, RemoteDebugLaunch, RemoteDebugSnapshot } from '@/shared/types';

/** A PC as GET /api/aidev/targets reports it (the fields this form needs). */
type Target = { id: number; name: string; online: boolean; allowed_roots: string[]; is_default?: number | boolean; capabilities: { features?: string[]; runner?: string; tools?: Record<string, string> } | null };
export type DebugProject = { path: string; name: string };

const ADAPTERS: Array<{ id: RemoteDebugAdapter; label: string; hint: string }> = [
  { id: 'js-debug', label: 'Node.js · TypeScript (js-debug)', hint: 'src/index.js' },
  { id: 'debugpy', label: 'Python (debugpy)', hint: 'main.py' },
  { id: 'codelldb', label: 'C · C++ · Rust · Swift (LLDB)', hint: 'target/debug/app · build/app' },
  { id: 'gdb', label: 'C · C++ · Rust · Go · 임베디드 (GDB 14+)', hint: 'build/app · firmware.elf' },
  { id: 'lldb-dap', label: 'Apple 앱 · iOS 시뮬레이터 (Xcode lldb-dap)', hint: 'Build/Products/Debug/App.app/Contents/MacOS/App' },
  { id: 'netcoredbg', label: '.NET 6+ · C# · F# (WPF/WinForms/Avalonia/MAUI/ASP.NET)', hint: 'bin/Debug/net8.0/App.dll' },
  { id: 'clrdbg', label: '.NET Framework 4.x (Windows)', hint: 'bin\\Debug\\App.exe' },
  { id: 'mono', label: 'Mono · Unity', hint: 'bin/Debug/App.exe' },
  { id: 'delve', label: 'Go (delve)', hint: '. (패키지 폴더)' },
  { id: 'jvm', label: 'Java · Kotlin · Scala (JDI)', hint: 'build/libs/app.jar' },
  { id: 'dart', label: 'Dart', hint: 'bin/main.dart' },
  { id: 'flutter', label: 'Flutter (모든 기기)', hint: 'lib/main.dart' },
  { id: 'probe-rs', label: '마이크로컨트롤러 (probe-rs)', hint: 'target/thumbv7em-none-eabihf/debug/fw' },
  { id: 'custom', label: '기타 DAP 서버 (직접 지정)', hint: '(선택) 프로그램' },
];
/** attach targets each adapter understands: a process id, a debug server address, or both */
const ATTACH: Partial<Record<RemoteDebugAdapter, { pid: boolean; address: string | null }>> = {
  'js-debug': { pid: true, address: '127.0.0.1:9229 (node --inspect)' },
  debugpy: { pid: true, address: '127.0.0.1:5678 (debugpy --listen)' },
  codelldb: { pid: true, address: null },
  gdb: { pid: true, address: 'localhost:3333 (gdbserver · OpenOCD · QEMU)' },
  'lldb-dap': { pid: true, address: null },
  netcoredbg: { pid: true, address: null },
  clrdbg: { pid: true, address: null },
  mono: { pid: false, address: '127.0.0.1:55555 (--debugger-agent)' },
  delve: { pid: true, address: '127.0.0.1:2345 (dlv --headless)' },
  jvm: { pid: false, address: '127.0.0.1:5005 (JDWP · adb forward)' },
  dart: { pid: false, address: 'ws://127.0.0.1:8181/…/ws (VM service)' },
  flutter: { pid: false, address: 'ws://127.0.0.1:…/ws (VM service)' },
  'probe-rs': { pid: false, address: null },
  custom: { pid: true, address: 'host:port' },
};
const RUNTIMES = ['node', 'npm', 'npx', 'yarn', 'pnpm', 'tsx'];

/**
 * "새 디버그" (F-09): what to run under the debugger on which PC. The workspace project is copied to the PC
 * first (remote_sync, changed files only) unless unticked; the editor's breakpoints in that project go
 * along (as paths relative to the PC folder). Used by DebugPane.
 */
export function DebugStartForm({ project, onStarted, onCancel }: { project: DebugProject | null; onStarted: (session: RemoteDebugSnapshot) => void; onCancel?: () => void }) {
  const store = useDebugStore();
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState<number | null>(null);
  const [program, setProgram] = useState('');
  // null = follow the program's extension
  const [adapterPick, setAdapterPick] = useState<RemoteDebugAdapter | null>(null);
  const [runtime, setRuntime] = useState('node');
  const [runtimeArgs, setRuntimeArgs] = useState('');
  const [module, setModule] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [cwdEdited, setCwdEdited] = useState(false);
  const [sync, setSync] = useState(Boolean(project));
  const [stopOnEntry, setStopOnEntry] = useState(false);
  const [request, setRequest] = useState<'launch' | 'attach'>('launch');
  const [pid, setPid] = useState('');
  const [address, setAddress] = useState('');
  const [gdbBin, setGdbBin] = useState('');
  const [mainClass, setMainClass] = useState('');
  const [classPath, setClassPath] = useState('');
  const [chip, setChip] = useState('');
  const [device, setDevice] = useState('');
  const [command, setCommand] = useState('');
  const [commandArgs, setCommandArgs] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'tcp'>('stdio');
  const [where, setWhere] = useState<'pc' | 'android' | 'ios-sim'>('pc');
  const [appId, setAppId] = useState('');
  const [activity, setActivity] = useState('');
  const [gdbServer, setGdbServer] = useState('');
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await readApiJson<{ targets: Target[] }>(await api.targets.list());
        setTargets(r.targets);
        setTargetId((cur) => cur ?? (r.targets.find((t) => t.online && t.is_default) ?? r.targets.find((t) => t.online) ?? r.targets[0])?.id ?? null);
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    })();
  }, []);
  const target = targets.find((t) => t.id === targetId) ?? null;
  // the PC folder follows the target (its first allowed folder) until the user types their own
  useEffect(() => { if (!cwdEdited) setCwd(defaultTargetFolder(project?.path ?? null, target?.allowed_roots ?? [])); }, [target, project, cwdEdited]);

  const adapter = adapterPick ?? (module ? 'debugpy' : program ? adapterFor(program) : 'js-debug');
  const noDap = target && !target.capabilities?.features?.includes('dap');
  const npmMode = adapter === 'js-debug' && runtime !== 'node' && request === 'launch';
  const attach = request === 'attach';
  const attachKinds = ATTACH[adapter] ?? { pid: true, address: null };
  // a phone/simulator app (device bridges): Android for jvm, iOS Simulator for the LLDB adapters
  const mobile = where === 'android' && adapter === 'jvm' ? 'android' as const : where === 'ios-sim' && (adapter === 'lldb-dap' || adapter === 'codelldb') ? 'ios-sim' as const : null;
  const jvmClass = adapter === 'jvm' && !attach && !mobile && Boolean(mainClass.trim());
  const serverArgv = adapter === 'gdb' ? splitArgs(gdbServer) : [];
  // editor breakpoints of this project, as paths relative to the PC folder
  const breakpoints = useMemo(() => {
    if (!project) return [];
    const map = { runtimeRoot: project.path, targetRoot: '.' };
    return Object.entries(store.breakpoints).flatMap(([path, lines]) => {
      const rel = toTargetPath(path, map)?.replace(/^\.\//, '');
      return rel && rel !== '.' ? lines.map((line) => ({ path: rel, line })) : [];
    });
  }, [store.breakpoints, project]);

  const start = async () => {
    if (!target) return;
    setError(null);
    try {
      if (sync && project) {
        setPhase('프로젝트를 PC로 복사하는 중…');
        await readApiJson(await api.targets.sync(target.id, project.path, { dest: cwd }));
      }
      setPhase(`${ADAPTERS.find((a) => a.id === adapter)?.label} 시작 중… (처음이면 어댑터를 내려받습니다)`);
      const launch: RemoteDebugLaunch = {
        adapter, request, cwd, args: splitArgs(args), stopOnEntry, breakpoints, waitSec: 0,
        ...(adapter === 'debugpy' && module && !attach ? { module } : {}),
        ...(npmMode ? { runtimeExecutable: runtime, runtimeArgs: splitArgs(runtimeArgs) } : {}),
        ...(program.trim() && !(adapter === 'debugpy' && module) && !jvmClass ? { program: program.trim() } : {}),
        ...(mobile ? { mobile, appId: appId.trim(), ...(activity.trim() && mobile === 'android' ? { activity: activity.trim() } : {}), ...(device.trim() ? { device: device.trim() } : {}) } : {}),
        ...(serverArgv.length ? { server: serverArgv } : {}),
        ...(attach && pid.trim() ? { pid: Number(pid) } : {}),
        ...(attach && address.trim() ? { address: address.trim() } : {}),
        ...(adapter === 'gdb' && gdbBin.trim() ? { debugger: gdbBin.trim() } : {}),
        ...(jvmClass ? { mainClass: mainClass.trim(), classPath: classPath.split(/[,;:]\s*|\s+/).filter(Boolean) } : {}),
        ...(adapter === 'probe-rs' && chip.trim() ? { chip: chip.trim() } : {}),
        ...(adapter === 'flutter' && device.trim() ? { device: device.trim() } : {}),
        ...(adapter === 'custom' ? { command: command.trim(), commandArgs: splitArgs(commandArgs), transport } : {}),
      };
      const r = await readApiJson<{ session: RemoteDebugSnapshot }>(await debugApi.start(target.id, launch));
      if (project && r.session.cwd) debugStore.setMap(r.session.id, { runtimeRoot: project.path, targetRoot: r.session.cwd });
      debugStore.select(r.session.id);
      onStarted(r.session);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase(null);
    }
  };

  const field = 'h-7 rounded border border-border bg-background px-2 text-xs text-foreground';
  const pidOk = /^\d+$/.test(pid.trim());
  const ready = target?.online && !noDap && (adapter !== 'custom' || command.trim()) && (adapter !== 'probe-rs' || chip.trim()) && (mobile ? Boolean(appId.trim()) : serverArgv.length ? serverArgv.some((a) => a.includes('{port}')) : attach
    ? (pidOk || Boolean(address.trim()) || ((adapter === 'codelldb' || adapter === 'lldb-dap') && Boolean(program.trim())))
    : Boolean(program.trim() || (adapter === 'debugpy' && module) || npmMode || jvmClass || adapter === 'custom'));
  const hint = ADAPTERS.find((a) => a.id === adapter)?.hint ?? '';
  return (
    <div className="space-y-2 p-3 text-xs" data-testid="debug-start-form">
      <div className="grid grid-cols-[5.5rem_1fr] items-center gap-x-2 gap-y-1.5">
        <span className="text-muted-foreground">PC</span>
        <select aria-label="원격 PC" value={targetId ?? ''} onChange={(e) => setTargetId(Number(e.target.value) || null)} className={field}>
          {targets.map((t) => <option key={t.id} value={t.id}>{t.name}{t.online ? '' : ' (오프라인)'}{t.is_default ? ' · 기본' : ''}</option>)}
        </select>
        <span className="text-muted-foreground">디버거</span>
        <select aria-label="디버거" value={adapter} onChange={(e) => setAdapterPick(e.target.value as RemoteDebugAdapter)} className={field}>
          {ADAPTERS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        <span className="text-muted-foreground">방식</span>
        <div className="flex gap-3">
          <label className="flex items-center gap-1"><input type="radio" name="dbg-request" checked={!attach} onChange={() => setRequest('launch')} /> 실행해서 디버그</label>
          <label className="flex items-center gap-1"><input type="radio" name="dbg-request" checked={attach} onChange={() => setRequest('attach')} /> 실행 중인 것에 연결</label>
        </div>
        <span className="text-muted-foreground">프로그램</span>
        <input aria-label="프로그램" value={program} onChange={(e) => setProgram(e.target.value)} placeholder={attach ? '(선택) 심볼용 실행 파일' : `${hint} (PC 폴더 기준)`} className={field} />
        {attach ? (
          <>
            {attachKinds.pid ? (<><span className="text-muted-foreground">프로세스 ID</span><input aria-label="프로세스 ID" value={pid} onChange={(e) => setPid(e.target.value)} placeholder="1234" inputMode="numeric" className={field} /></>) : null}
            {attachKinds.address ? (<><span className="text-muted-foreground">주소</span><input aria-label="디버그 서버 주소" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={attachKinds.address} className={field} /></>) : null}
          </>
        ) : null}
        {adapter === 'jvm' || adapter === 'lldb-dap' || adapter === 'codelldb' ? (
          <>
            <span className="text-muted-foreground">어디서</span>
            <select aria-label="실행 위치" value={where} onChange={(e) => setWhere(e.target.value as 'pc' | 'android' | 'ios-sim')} className={field}>
              <option value="pc">이 PC</option>
              {adapter === 'jvm' ? <option value="android">Android 기기·에뮬레이터 (adb)</option> : <option value="ios-sim">iOS 시뮬레이터 (Mac)</option>}
            </select>
          </>
        ) : null}
        {mobile ? (
          <>
            <span className="text-muted-foreground">{mobile === 'android' ? '패키지' : '번들 ID'}</span>
            <input aria-label="앱 ID" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder={mobile === 'android' ? 'com.example.app (debug 빌드 설치 후)' : 'com.example.App (시뮬레이터에 설치 후)'} className={field} />
            {mobile === 'android' ? (<><span className="text-muted-foreground">액티비티</span><input aria-label="액티비티" value={activity} onChange={(e) => setActivity(e.target.value)} placeholder="(선택) .MainActivity — 비우면 런처 액티비티" className={field} /></>) : null}
            <span className="text-muted-foreground">기기</span>
            <input aria-label="기기" value={device} onChange={(e) => setDevice(e.target.value)} placeholder={mobile === 'android' ? '(선택) adb 시리얼 — 한 대면 비움' : '(선택) 시뮬레이터 UDID — 비우면 부팅된 것'} className={field} />
          </>
        ) : null}
        {adapter === 'gdb' ? (<><span className="text-muted-foreground">GDB 서버</span><input aria-label="GDB 서버" value={gdbServer} onChange={(e) => setGdbServer(e.target.value)} placeholder="(선택) gdbserver 127.0.0.1:{port} ./app · openocd -f board/x.cfg -c 'gdb_port {port}'" className={field} /></>) : null}
        {adapter === 'gdb' ? (<><span className="text-muted-foreground">GDB</span><input aria-label="GDB 실행 파일" value={gdbBin} onChange={(e) => setGdbBin(e.target.value)} placeholder="gdb (기본) · gdb-multiarch · arm-none-eabi-gdb" className={field} /></>) : null}
        {adapter === 'jvm' && !attach && !mobile ? (
          <>
            <span className="text-muted-foreground">메인 클래스</span>
            <input aria-label="메인 클래스" value={mainClass} onChange={(e) => setMainClass(e.target.value)} placeholder="com.acme.App (프로그램 .jar 대신)" className={field} />
            <span className="text-muted-foreground">클래스패스</span>
            <input aria-label="클래스패스" value={classPath} onChange={(e) => setClassPath(e.target.value)} placeholder="build/classes/java/main, lib/*.jar" className={field} />
          </>
        ) : null}
        {adapter === 'probe-rs' ? (<><span className="text-muted-foreground">칩</span><input aria-label="칩" value={chip} onChange={(e) => setChip(e.target.value)} placeholder="STM32F411RETx · nRF52840_xxAA · esp32c3" className={field} /></>) : null}
        {adapter === 'flutter' ? (<><span className="text-muted-foreground">기기</span><input aria-label="Flutter 기기" value={device} onChange={(e) => setDevice(e.target.value)} placeholder="(선택) flutter devices의 id" className={field} /></>) : null}
        {adapter === 'custom' ? (
          <>
            <span className="text-muted-foreground">DAP 서버</span>
            <input aria-label="DAP 서버 명령" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="lldb-dap · OpenDebugAD7 · …" className={field} />
            <span className="text-muted-foreground">서버 인자</span>
            <div className="flex gap-1.5">
              <input aria-label="DAP 서버 인자" value={commandArgs} onChange={(e) => setCommandArgs(e.target.value)} placeholder="--port {port}" className={`${field} min-w-0 flex-1`} />
              <select aria-label="전송 방식" value={transport} onChange={(e) => setTransport(e.target.value === 'tcp' ? 'tcp' : 'stdio')} className={`${field} w-20`}><option value="stdio">stdio</option><option value="tcp">tcp</option></select>
            </div>
          </>
        ) : null}
        {adapter === 'js-debug' && !attach ? (
          <>
            <span className="text-muted-foreground">실행</span>
            <div className="flex gap-1.5">
              <select aria-label="실행 방식" value={runtime} onChange={(e) => setRuntime(e.target.value)} className={`${field} w-20`}>{RUNTIMES.map((r) => <option key={r} value={r}>{r}</option>)}</select>
              {npmMode ? <input aria-label="실행 인자" value={runtimeArgs} onChange={(e) => setRuntimeArgs(e.target.value)} placeholder="test · run dev" className={`${field} min-w-0 flex-1`} /> : <span className="self-center text-muted-foreground">node &lt;프로그램&gt;</span>}
            </div>
          </>
        ) : null}
        {adapter === 'debugpy' && !attach ? (
          <>
            <span className="text-muted-foreground">모듈</span>
            <input aria-label="모듈" value={module} onChange={(e) => setModule(e.target.value)} placeholder="(선택) pytest · uvicorn — 프로그램 대신 python -m" className={field} />
          </>
        ) : null}
        <span className="text-muted-foreground">인자</span>
        <input aria-label="인자" value={args} onChange={(e) => setArgs(e.target.value)} placeholder='--port 3000 "a b"' className={field} />
        <span className="text-muted-foreground">PC 폴더</span>
        <input aria-label="PC 폴더" value={cwd} onChange={(e) => { setCwd(e.target.value); setCwdEdited(true); }} className={`${field} aidev-selectable`} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {project ? <label className="flex items-center gap-1.5"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /> 먼저 {project.name}을(를) PC 폴더로 복사</label> : null}
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={stopOnEntry} onChange={(e) => setStopOnEntry(e.target.checked)} /> 첫 줄에서 멈춤</label>
        <span className="text-muted-foreground">중단점 {breakpoints.length}개 (편집기 줄 번호 왼쪽을 눌러 추가)</span>
      </div>
      {noDap ? <div className="text-amber-600">이 PC의 러너({target?.capabilities?.runner ?? '?'})는 디버깅을 지원하지 않습니다 — aidev-runner 0.8.0 이상으로 교체하세요 (Mac: ops/runner/install.sh).</div> : null}
      {phase ? <div className="text-primary">{phase}</div> : null}
      {error ? <div className="aidev-selectable whitespace-pre-wrap text-red-600">{error}</div> : null}
      <div className="flex gap-1.5">
        <button type="button" disabled={!ready || Boolean(phase)} onClick={() => { void start(); }} className="inline-flex h-7 items-center gap-1 rounded bg-primary px-3 text-primary-foreground disabled:opacity-50"><Play size={12} /> 디버그 시작</button>
        {onCancel ? <button type="button" onClick={onCancel} className="h-7 rounded border border-border px-3 hover:bg-muted">취소</button> : null}
      </div>
    </div>
  );
}
