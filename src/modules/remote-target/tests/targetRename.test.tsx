import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SharedApi from '@/shared/api';

/** "원격 대상": the owner renames a PC from its row; a guest of a shared PC sees no name field. */
const { json, targets, update } = vi.hoisted(() => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const pc = (id: number, name: string, sharedBy: string | null = null) => ({
    id, name, description: '', platform: 'linux', arch: 'x64', policy: 'full', paired: true, online: false, status: 'offline',
    is_default: 0, shared_by: sharedBy, last_seen: null, pairing_code: null, pairing_expires: null, allowed_roots: [], capabilities: null,
  });
  const targets = { list: [pc(1, 'office'), pc(2, 'lab', 'bob')] };
  const update = vi.fn(async (id: number, input: { name?: string }) => {
    if (input.name === 'lab') return json({ error: '이미 lab 이름의 PC가 있습니다' }, 400);
    targets.list = targets.list.map((t) => (t.id === id && input.name ? { ...t, name: input.name } : t));
    return json({ ok: true });
  });
  return { json, targets, update };
});

vi.mock('@/shared/api', async (original) => {
  const real = await original<typeof SharedApi>();
  return {
    ...real,
    api: {
      ...real.api,
      targets: {
        ...real.api.targets,
        list: async () => json({ targets: targets.list }),
        runnerDownloads: async () => json({ files: [] }),
        shares: async () => json({ shares: [] }),
        update: (id: number, input: { name?: string }) => update(id, input),
      },
    },
  };
});
const { TargetsPanel } = await import('@/modules/remote-target/TargetsPanel');

class RO { observe() {} disconnect() {} }
beforeEach(() => { (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO; update.mockClear(); });

describe('TargetsPanel rename', () => {
  it('renames the owner\'s PC, keeps the typed name on a clash, and offers no field on a shared PC', async () => {
    render(<TargetsPanel />);
    fireEvent.click(await screen.findByText('office'));
    const field = screen.getByLabelText('PC 이름') as HTMLInputElement;
    expect(field.value).toBe('office');
    expect(screen.queryByRole('button', { name: /이름 변경/ })).toBeNull();

    // typed as agents write it: lowercase, anything else becomes a dash
    fireEvent.change(field, { target: { value: 'Lab' } });
    expect(field.value).toBe('lab');
    fireEvent.click(screen.getByRole('button', { name: /이름 변경/ }));
    expect(await screen.findByText('이미 lab 이름의 PC가 있습니다')).toBeTruthy();
    expect(field.value).toBe('lab');

    fireEvent.change(field, { target: { value: 'Office PC' } });
    expect(field.value).toBe('office-pc');
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(1, { name: 'office-pc' }));
    expect(await screen.findByText(/office → office-pc/)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText('PC 이름') as HTMLInputElement).value).toBe('office-pc'));
    expect(screen.queryByRole('button', { name: /이름 변경/ })).toBeNull();

    // a name agents could not write cannot be sent
    fireEvent.change(screen.getByLabelText('PC 이름'), { target: { value: '-' } });
    expect((screen.getByRole('button', { name: /이름 변경/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText('lab'));
    expect(screen.getAllByLabelText('PC 이름')).toHaveLength(1);
  });
});
