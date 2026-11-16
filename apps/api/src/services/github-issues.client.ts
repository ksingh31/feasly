/**
 * Minimal GitHub Issues client (#757) — fetch-only, no SDK.
 *
 * Used by the zoning watcher to file one "Zoning catalogue may be out of
 * date" issue. The token is never logged or put in an error message.
 */

export interface GitHubIssueRef {
  readonly number: number;
  readonly url: string;
}

export interface GitHubIssuesClient {
  /** The open issue whose title is exactly `title`, if any. */
  findOpenByTitle(title: string): Promise<GitHubIssueRef | undefined>;
  create(input: { title: string; body: string; labels: readonly string[] }): Promise<GitHubIssueRef>;
  comment(issueNumber: number, body: string): Promise<void>;
}

export interface GitHubIssuesClientConfig {
  /** `owner/repo`. */
  readonly repo: string;
  readonly token: string;
  readonly httpTimeoutMs: number;
  /** GitHub REST base URL (config `ZONING_WATCH_GITHUB_API_URL`). */
  readonly apiBaseUrl: string;
}

export function createGitHubIssuesClient(
  config: GitHubIssuesClientConfig,
  fetchImpl: typeof fetch = fetch,
): GitHubIssuesClient {
  const base = config.apiBaseUrl.replace(/\/+$/, '');

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.httpTimeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${config.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'feasly-zoning-watch',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} failed: HTTP ${res.status}`);
      return (await res.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  function refOf(value: unknown): GitHubIssueRef | undefined {
    if (value === null || typeof value !== 'object') return undefined;
    const v = value as Record<string, unknown>;
    return typeof v['number'] === 'number' && typeof v['html_url'] === 'string'
      ? { number: v['number'], url: v['html_url'] }
      : undefined;
  }

  return {
    async findOpenByTitle(title): Promise<GitHubIssueRef | undefined> {
      const q = `repo:${config.repo} is:issue is:open in:title "${title.replace(/"/g, '')}"`;
      const body = await call('GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=20`);
      const items =
        body !== null && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['items'])
          ? ((body as Record<string, unknown>)['items'] as unknown[])
          : [];
      for (const item of items) {
        if (item !== null && typeof item === 'object' && (item as Record<string, unknown>)['title'] === title) {
          const ref = refOf(item);
          if (ref) return ref;
        }
      }
      return undefined;
    },

    async create({ title, body, labels }): Promise<GitHubIssueRef> {
      const ref = refOf(await call('POST', `/repos/${config.repo}/issues`, { title, body, labels }));
      if (!ref) throw new Error('GitHub issue create returned an unexpected body');
      return ref;
    },

    async comment(issueNumber, body): Promise<void> {
      await call('POST', `/repos/${config.repo}/issues/${issueNumber}/comments`, { body });
    },
  };
}
