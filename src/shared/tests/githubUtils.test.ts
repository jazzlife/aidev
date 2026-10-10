import { afterEach, describe, expect, it } from 'vitest';

import { joinFolderPath, repoFolderName, takeGithubReturn } from '@/shared/utils';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('repoFolderName', () => {
  it('names the folder a clone lands in as the server does', () => {
    expect(repoFolderName('https://github.com/a/b.git/')).toBe('b');
    expect(repoFolderName('git@github.com:a/c.git')).toBe('c');
    expect(repoFolderName('  ')).toBe('');
  });
});

describe('joinFolderPath', () => {
  it('keeps the directory\'s own separator', () => {
    expect(joinFolderPath('/w/new/', 'app')).toBe('/w/new/app');
    expect(joinFolderPath('C:\\work', 'app')).toBe('C:\\work\\app');
  });
});

describe('takeGithubReturn', () => {
  it('reads the login outcome once and cleans the address, keeping other parameters', () => {
    window.history.replaceState(null, '', '/session/abc?add=clone&github=connected&account=jazzlife&keep=1');
    expect(takeGithubReturn()).toEqual({ text: 'GitHub 계정이 연결되었습니다 (@jazzlife)', error: false });
    expect(window.location.pathname + window.location.search).toBe('/session/abc?keep=1');
    expect(takeGithubReturn()).toBeNull();
  });

  it('reports a failed login with the gateway\'s reason', () => {
    window.history.replaceState(null, '', '/?settings=api&github=error&reason=denied');
    expect(takeGithubReturn()).toEqual({ text: 'GitHub 로그인 실패: denied', error: true });
    expect(window.location.search).toBe('');
  });
});
