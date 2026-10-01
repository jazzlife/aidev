import { useCallback, useEffect, useState } from 'react';
import { Camera, RefreshCw, Smartphone } from 'lucide-react';

import { api, readApiJson } from '@/shared/api';

/** A phone, TV or simulator attached to the target PC (GET /api/aidev/targets/:id/devices). */
type Device = { tool: 'adb' | 'sdb' | 'sim'; serial: string; state: string; name: string };

const TOOL_LABEL: Record<Device['tool'], string> = { adb: 'Android', sdb: 'Tizen', sim: 'iOS 시뮬레이터' };
const STATE_HINT: Record<string, string> = { unauthorized: '휴대폰에서 USB 디버깅 허용 필요', offline: '오프라인' };

/**
 * Used by TargetsPanel (F-10): the devices attached to an online target, each with a screenshot on demand
 * (shown inline; needs the PC owner's screen-capture consent, every capture is recorded).
 */
export function DevicesSection({ targetId }: { targetId: number }) {
  // devices: null while loading; error: why the list or a capture failed
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // shot: the last capture (data URL) and which device it shows; busy: serial being captured
  const [shot, setShot] = useState<{ serial: string; src: string; size: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api.targets.devices(targetId).then((r) => readApiJson<{ devices: Device[] }>(r)).then((body) => { setError(null); setDevices(body.devices); }).catch((e: Error) => { setDevices([]); setError(e.message); });
  }, [targetId]);
  useEffect(load, [load]);

  const capture = async (device: Device) => {
    setBusy(device.serial);
    setError(null);
    try {
      const body = await readApiJson<{ image: string; mime: string; width: number; height: number; ms: number }>(await api.targets.deviceShot(targetId, { tool: device.tool, serial: device.serial }));
      setShot({ serial: device.serial, src: `data:${body.mime};base64,${body.image}`, size: `${body.width}×${body.height} · ${body.ms}ms` });
    } catch (e) {
      setError(e instanceof Error ? e.message : '캡처 실패');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="target-devices">
      <div className="flex items-center gap-1 text-muted-foreground">
        <Smartphone size={11} /> 기기 {devices ? `${devices.length}대` : '…'}
        <button type="button" onClick={load} aria-label="기기 새로고침" className="rounded p-0.5 hover:bg-accent"><RefreshCw size={10} /></button>
      </div>
      {devices?.map((d) => (
        <div key={`${d.tool}:${d.serial}`} className="flex items-center gap-1.5 pl-3">
          <span className="truncate">{d.name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{TOOL_LABEL[d.tool] ?? d.tool} · {d.serial}</span>
          {d.state === 'device'
            ? <button type="button" disabled={busy !== null} onClick={() => { void capture(d); }} className="ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded border border-border px-1.5 hover:bg-accent disabled:opacity-50"><Camera size={10} /> {busy === d.serial ? '캡처 중…' : '화면'}</button>
            : <span className="ml-auto shrink-0 text-[10px] text-amber-600">{STATE_HINT[d.state] ?? d.state}</span>}
        </div>
      ))}
      {error ? <div className="pl-3 text-[10px] text-rose-600">{error}</div> : null}
      {shot ? (
        <figure className="mt-1 pl-3">
          <img src={shot.src} alt={`${shot.serial} 화면`} className="max-h-80 rounded border border-border" />
          <figcaption className="text-[10px] text-muted-foreground">{shot.serial} · {shot.size} · 실시간 미러링은 2단계(device.mirror)</figcaption>
        </figure>
      ) : null}
    </div>
  );
}
