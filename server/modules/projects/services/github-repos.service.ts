import { githubTokensDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * The repositories of the GitHub account the user connected (a stored `github_token` credential), so adding a project
 * can pick one instead of typing its URL (2026-10-05). The newest pushed first, 100 per page.
 */
type RepoRow = {
  full_name: string; name: string; owner?: { login?: string }; private: boolean; description: string | null;
  clone_url: string; pushed_at: string | null; default_branch: string; archived?: boolean; fork?: boolean;
};

export type GithubRepo = {
  fullName: string; name: string; owner: string; private: boolean; description: string | null;
  cloneUrl: string; pushedAt: string | null; defaultBranch: string; archived: boolean; fork: boolean;
};

type GithubReposDependencies = {
  listTokens: (userId: number) => Array<{ id: number; credential_name: string; is_active: boolean | number }>;
  tokenValue: (userId: number, tokenId: number) => string | null;
  fetch: typeof fetch;
};

const defaultDependencies: GithubReposDependencies = {
  listTokens: (userId) => githubTokensDb.getGithubTokens(userId) as Array<{ id: number; credential_name: string; is_active: boolean | number }>,
  tokenValue: (userId, tokenId) => githubTokensDb.getGithubTokenById(userId, tokenId)?.github_token ?? null,
  fetch: (...args) => fetch(...args),
};

const PER_PAGE = 100;

async function github<T>(deps: GithubReposDependencies, token: string, path: string): Promise<{ body: T; link: string | null }> {
  const response = await deps.fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'nadovibe' },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new AppError('GitHub 토큰이 만료되었거나 취소되었습니다. 새 토큰으로 다시 연결하세요.', { code: 'GITHUB_TOKEN_INVALID', statusCode: 401 });
  if (!response.ok) throw new AppError(`GitHub이 저장소 목록을 주지 않았습니다 (${response.status})`, { code: 'GITHUB_REQUEST_FAILED', statusCode: 502 });
  return { body: await response.json() as T, link: response.headers.get('link') };
}

/** Used by the projects routes: the connected account (or `tokenId`'s) and one page of its repositories. */
export async function listGithubRepos(input: { userId: number; tokenId?: number | null; page?: number }, deps: GithubReposDependencies = defaultDependencies) {
  const tokens = deps.listTokens(input.userId).filter((token) => Boolean(token.is_active));
  const chosen = input.tokenId ? tokens.find((token) => token.id === input.tokenId) : tokens[0];
  if (!chosen) throw new AppError('연결된 GitHub 계정이 없습니다', { code: 'GITHUB_NOT_CONNECTED', statusCode: 404 });
  const value = deps.tokenValue(input.userId, chosen.id);
  if (!value) throw new AppError('연결된 GitHub 계정이 없습니다', { code: 'GITHUB_NOT_CONNECTED', statusCode: 404 });
  const page = Math.max(1, Math.min(input.page ?? 1, 50));
  const [{ body: user }, { body: rows, link }] = await Promise.all([
    github<{ login: string; avatar_url?: string }>(deps, value, '/user'),
    github<RepoRow[]>(deps, value, `/user/repos?per_page=${PER_PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`),
  ]);
  return {
    account: { login: user.login, avatarUrl: user.avatar_url ?? null },
    tokenId: chosen.id,
    tokens: tokens.map((token) => ({ id: token.id, name: token.credential_name })),
    repos: rows.map((row): GithubRepo => ({
      fullName: row.full_name, name: row.name, owner: row.owner?.login ?? row.full_name.split('/')[0] ?? '', private: row.private,
      description: row.description, cloneUrl: row.clone_url, pushedAt: row.pushed_at, defaultBranch: row.default_branch,
      archived: Boolean(row.archived), fork: Boolean(row.fork),
    })),
    page,
    hasMore: Boolean(link && /rel="next"/.test(link)),
  };
}
