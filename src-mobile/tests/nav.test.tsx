import { act, render, screen } from '@testing-library/react';
import { BrowserRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';

import { BackController, useBackOverlay, useGo, useParent } from '@m/lib/nav';

/** Mobile back = up (2026-10-02, "뒤로가기는 이전페이지가 되어서는 안돼"): the hardware back button never returns to the
 *  previous page, it goes to the screen's parent; an open overlay closes first; at the root it leaves the app. */
function Home() {
  useParent(null);
  const go = useGo();
  const [sheet, setSheet] = useState(false);
  useBackOverlay(sheet, () => setSheet(false));
  return <div><span>home</span>{sheet ? <span>sheet open</span> : null}<button onClick={() => go('/session/s1')}>open</button><button onClick={() => setSheet(true)}>sheet</button></div>;
}
function Project() {
  useParent('/projects');
  const go = useGo();
  return <div>project {useParams().id}<button onClick={() => go('/session/s2')}>open2</button></div>;
}
function Session() {
  const { id } = useParams();
  useParent(id === 's1' ? '/projects/a' : '/projects/b');
  return <div>session {id}</div>;
}
function Projects() { useParent('/'); return <div>projects</div>; }

const app = () => render(
  <BrowserRouter>
    <BackController />
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/projects" element={<Projects />} />
      <Route path="/projects/:id" element={<Project />} />
      <Route path="/session/:id" element={<Session />} />
    </Routes>
  </BrowserRouter>,
);
/** The Android back button: one history step back (popstate). */
const back = async () => { await act(async () => { window.history.back(); await new Promise((r) => setTimeout(r, 30)); }); };

afterEach(() => { window.history.replaceState(null, '', '/'); });

describe('mobile back = up', () => {
  it('goes to the parent, not the page that came before, and the history never grows', async () => {
    window.history.replaceState(null, '', '/');
    app();
    const length = window.history.length;
    act(() => { screen.getByText('open').click(); });   // home → session s1 (parent: project a)
    expect(screen.getByText('session s1')).toBeTruthy();
    expect(window.history.length).toBe(length);
    await back();
    expect(screen.getByText('project a')).toBeTruthy();   // not home
    act(() => { screen.getByText('open2').click(); });
    await back();
    expect(screen.getByText('project b')).toBeTruthy();   // s2's project, not project a it was opened from
    await back();
    expect(screen.getByText('projects')).toBeTruthy();
    await back();
    expect(screen.getByText('home')).toBeTruthy();
    expect(window.history.length).toBe(length);
  });

  it('closes an open overlay before leaving the screen', async () => {
    window.history.replaceState(null, '', '/');
    app();
    act(() => { screen.getByText('sheet').click(); });
    expect(screen.queryByText('sheet open')).toBeTruthy();
    await back();
    expect(screen.queryByText('sheet open')).toBeNull();
    expect(screen.getByText('home')).toBeTruthy();
    expect(window.location.pathname).toBe('/');
  });

  it('a deep link (opened on a conversation) still goes up to its project', async () => {
    window.history.replaceState(null, '', '/session/s1');
    app();
    expect(screen.getByText('session s1')).toBeTruthy();
    await back();
    expect(screen.getByText('project a')).toBeTruthy();
  });
});
