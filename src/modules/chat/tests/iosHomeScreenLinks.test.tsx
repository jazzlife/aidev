import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The iPhone/iPad home-screen app has no browser chrome: a page of this app's own origin (a preview at `/p/…`)
 * or a downloaded file opened in its window replaces the app with no way back. Chat opens such links in an
 * in-app viewer and saves attachments through the share sheet; everywhere else nothing changes.
 */

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor: vi.fn(), openDirectory: vi.fn() }),
}));

const assetFile = vi.fn(async (_name: string) => new Response(new Blob(['report'], { type: 'application/pdf' })));
vi.mock('@/shared/api', () => ({ api: { assets: { file: (name: string) => assetFile(name) } } }));

const { Markdown } = await import('@/modules/chat/transcript/Markdown');
const { default: ChatMessageFiles } = await import('@/modules/chat/transcript/ChatMessageFiles');

const setHomeScreenApp = (on: boolean) => {
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: on });
};

const preview = `${window.location.origin}/p/cap123/`;

beforeEach(() => setHomeScreenApp(true));
afterEach(() => {
  cleanup();
  setHomeScreenApp(false);
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'share');
  Reflect.deleteProperty(navigator, 'canShare');
});

describe('links in the iOS home-screen app', () => {
  it('opens a link to this app in the in-app viewer, which closes back to the chat', () => {
    render(<Markdown>{`미리보기: [열기](${preview})`}</Markdown>);
    const link = screen.getByText('열기');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { link.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe(preview);

    fireEvent.click(screen.getByText('닫기'));
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('leaves another site to iOS (its in-app browser has a 완료 button)', () => {
    render(<Markdown>{'[docs](https://example.com/docs)'}</Markdown>);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    screen.getByText('docs').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('changes nothing in a browser tab', () => {
    setHomeScreenApp(false);
    render(<Markdown>{`[열기](${preview})`}</Markdown>);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    screen.getByText('열기').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('attachments in the iOS home-screen app', () => {
  const attachment = [{ name: 'report.pdf', path: '/uploads/abc-report.pdf', size: 6 }];

  it('go to the share sheet instead of a download that would replace the app', async () => {
    const share = vi.fn(async () => undefined);
    Object.assign(navigator, { share, canShare: () => true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    render(<ChatMessageFiles files={attachment as never} />);

    await act(async () => { fireEvent.click(screen.getByRole('button')); });

    expect(share).toHaveBeenCalledTimes(1);
    const shared = (share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0];
    expect(shared.name).toBe('report.pdf');
    expect(click).not.toHaveBeenCalled();
  });

  it('ask for one more tap when iOS refuses the sheet after the download, and share from that tap', async () => {
    const share = vi.fn()
      .mockRejectedValueOnce(new DOMException('gesture', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined);
    Object.assign(navigator, { share, canShare: () => true });
    render(<ChatMessageFiles files={attachment as never} />);

    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(screen.getByText('한 번 더 누르면 저장')).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(share).toHaveBeenCalledTimes(2);
    expect(assetFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('한 번 더 누르면 저장')).toBeNull();
  });
});
