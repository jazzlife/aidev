import assert from 'node:assert/strict';
import test from 'node:test';

import { listGithubRepos } from '@/modules/projects/services/github-repos.service.js';
import { AppError } from '@/shared/utils.js';

type Deps = NonNullable<Parameters<typeof listGithubRepos>[1]>;

function deps(overrides: Partial<Deps> = {}, calls: string[] = []): Deps {
  return {
    listTokens: () => [{ id: 3, credential_name: 'old', is_active: 0 }, { id: 7, credential_name: 'GitHub', is_active: 1 }],
    tokenValue: (_userId, tokenId) => (tokenId === 7 ? 'ghp_x' : null),
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push(`${url} ${(init?.headers as Record<string, string>).authorization}`);
      const body = url.endsWith('/user') ? { login: 'jazzlife', avatar_url: 'a.png' }
        : [{ full_name: 'jazzlife/aidev', name: 'aidev', owner: { login: 'jazzlife' }, private: false, description: 'NadoVibe', clone_url: 'https://github.com/jazzlife/aidev.git', pushed_at: '2026-10-04T00:00:00Z', default_branch: 'main' }];
      return new Response(JSON.stringify(body), { status: 200, headers: url.endsWith('/user') ? {} : { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } });
    }) as typeof fetch,
    ...overrides,
  };
}

test('lists the connected account and its repositories, newest pushed first, with the active token', async () => {
  const calls: string[] = [];
  const result = await listGithubRepos({ userId: 1 }, deps({}, calls));
  assert.equal(result.account.login, 'jazzlife');
  assert.equal(result.tokenId, 7);
  assert.deepEqual(result.tokens, [{ id: 7, name: 'GitHub' }]);
  assert.equal(result.repos[0]?.cloneUrl, 'https://github.com/jazzlife/aidev.git');
  assert.equal(result.hasMore, true);
  assert.ok(calls.some((c) => c.includes('/user/repos?per_page=100&page=1&sort=pushed') && c.endsWith('Bearer ghp_x')));
});

test('no active GitHub token: says the account is not connected', async () => {
  await assert.rejects(listGithubRepos({ userId: 1 }, deps({ listTokens: () => [] })), (e: unknown) => e instanceof AppError && e.code === 'GITHUB_NOT_CONNECTED');
});

test('a revoked token is reported as such', async () => {
  const revoked = deps({ fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch });
  await assert.rejects(listGithubRepos({ userId: 1 }, revoked), (e: unknown) => e instanceof AppError && e.code === 'GITHUB_TOKEN_INVALID');
});
