import { act, fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { BrowserRouter, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { RouteProgress } from '@m/components/RouteProgress';
import { lazyScreen } from '@m/lib/lazyScreen';

/** C-12.1: moving to a screen whose code is still downloading keeps the current screen and shows the top line. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function Home() {
  const navigate = useNavigate();
  return <div><div data-testid="home">home</div><button type="button" onClick={() => navigate('/next')}>go</button></div>;
}

function Layout() {
  return <><RouteProgress /><Suspense fallback={<div data-testid="splash" />}><Outlet /></Suspense></>;
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

describe('screen transitions', () => {
  it('keep the screen on show while the next one downloads, with the progress line instead of the splash', async () => {
    const next = deferred<() => JSX.Element>();
    const Next = lazyScreen(() => next.promise);
    window.history.replaceState(null, '', '/');
    render(
      <BrowserRouter future={{ v7_startTransition: true }}>
        <Routes><Route element={<Layout />}><Route path="/" element={<Home />} /><Route path="/next" element={<Next />} /></Route></Routes>
      </BrowserRouter>,
    );
    expect(screen.getByTestId('route-progress').dataset.on).toBe('false');
    fireEvent.click(screen.getByText('go'));
    await flush();
    expect(screen.queryByTestId('splash')).toBeNull();
    expect(screen.getByTestId('home')).toBeTruthy();
    expect(screen.getByTestId('route-progress').dataset.on).toBe('true');
    await act(async () => { next.resolve(() => <div data-testid="next">next</div>); await next.promise; });
    await flush();
    expect(screen.getByTestId('next')).toBeTruthy();
    expect(screen.getByTestId('route-progress').dataset.on).toBe('false');
  });

  it('a prefetch in the background does not turn the line on, and the screen then opens at once', async () => {
    const code = deferred<() => JSX.Element>();
    const Later = lazyScreen(() => code.promise);
    window.history.replaceState(null, '', '/');
    render(
      <BrowserRouter future={{ v7_startTransition: true }}>
        <Routes><Route element={<Layout />}><Route path="/" element={<Home />} /><Route path="/next" element={<Later />} /></Route></Routes>
      </BrowserRouter>,
    );
    const preload = Later.preload();
    await flush();
    expect(screen.getByTestId('route-progress').dataset.on).toBe('false');
    await act(async () => { code.resolve(() => <div data-testid="later">later</div>); await preload; });
    fireEvent.click(screen.getByText('go'));
    await flush();
    expect(screen.getByTestId('later')).toBeTruthy();
    expect(screen.getByTestId('route-progress').dataset.on).toBe('false');
  });
});
