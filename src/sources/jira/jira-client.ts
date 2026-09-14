import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Logger } from "../../logging/logger.js";
import {
  changelogHistorySchema,
  issueSchema,
  jiraDate,
  toJiraIssue,
  type ChangelogHistory,
  type JiraIssue,
  type JiraSource,
  type LinkedPullRequest,
  type RawJiraIssue,
} from "./source.js";

export interface JiraClientOptions {
  /** Site root, e.g. https://example.atlassian.net */
  readonly baseUrl: string;
  readonly email: string;
  readonly token: string;
  readonly logger: Logger;
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Injected for tests. Defaults to a real delay. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const PAGE_SIZE = 100;

/** Jira Cloud rate limits per user and answers 429 with Retry-After; a few waits usually clear it. */
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;

/** Honours a numeric Retry-After (seconds); otherwise backs off 1s, 2s, 4s. Never waits longer than the cap. */
function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after")); // 0 when absent, NaN for an HTTP-date
  const seconds = retryAfter > 0 ? retryAfter : 2 ** attempt;
  return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
}

/** Fields the application reads; requesting only these keeps search responses small. */
const ISSUE_FIELDS = ["summary", "issuetype", "project", "status", "resolution", "created", "resolutiondate"];

/** `/search/jql` pages by opaque token; the token is absent (or null) on the last page. */
const searchPageSchema = z.object({
  issues: z.array(issueSchema),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().optional(),
});

/** `/issue/{id}/changelog` pages by offset (`startAt`), oldest history first. */
const changelogPageSchema = z.object({
  values: z.array(changelogHistorySchema),
  isLast: z.boolean(),
});

/** A search page when only issue keys were requested. */
const issueKeyPageSchema = z.object({
  issues: z.array(z.object({ key: z.string() })),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().optional(),
});

/** What every `/search/jql` page carries besides its issues. */
interface SearchPage {
  readonly issues: readonly unknown[];
  readonly nextPageToken?: string | null | undefined;
  readonly isLast?: boolean | undefined;
}

const statusesSchema = z.array(z.object({ id: z.string(), statusCategory: z.object({ key: z.string() }) }));

/**
 * Shapes of the (undocumented but long-stable) dev-status endpoints behind the
 * issue "Development" panel. The summary says which integration instances hold
 * pull requests for the issue; the detail call must name one of them as its
 * `applicationType` (e.g. `oAuth-com.github.integration.production` for GitHub
 * for Jira) or it returns nothing.
 */
const devStatusSummarySchema = z.object({
  summary: z.object({
    pullrequest: z.object({ byInstanceType: z.record(z.string(), z.object({ count: z.number() })) }).optional(),
  }),
});

const devStatusDetailSchema = z.object({
  detail: z.array(
    z.object({
      pullRequests: z
        .array(
          z.object({
            url: z.string(),
            name: z.string().nullish(),
            status: z.string(),
            lastUpdate: jiraDate,
            source: z.object({ branch: z.string().nullish() }).optional(),
          }),
        )
        .default([]),
    }),
  ),
});

const HINTS: Readonly<Record<number, string>> = {
  401: "Check ATLASSIAN_EMAIL and ATLASSIAN_TOKEN; the token may have expired",
  403: "The Jira user lacks permission for this resource (Browse Projects on the configured projects)",
  404: "Check ATLASSIAN_BASE_URL and the configured Jira project keys",
  410: "This Jira endpoint has been retired; the client needs updating",
  429: "Jira is still rate limiting this user after retries; rerun later",
};

/** Response bodies can be whole HTML pages; keep only enough to recognise them. */
function excerpt(body: string): string {
  return body.length > 300 ? `${body.slice(0, 300)}…` : body;
}

/** Turns a failed Jira call into an error that says what to check. */
export function describeJiraError(status: number, path: string, body: string): Error {
  const hint = HINTS[status];
  return new Error(`Jira request failed (HTTP ${status}) for ${path}: ${excerpt(body)}${hint ? `. ${hint}` : ""}`);
}

/** `JiraSource` for Jira Cloud using basic auth with an API token. */
export function createJiraClient(options: JiraClientOptions): JiraSource {
  const logger = options.logger.child({ source: "jira" });
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => delay(ms));
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const authorization = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString("base64")}`;

  async function fetchWithRateLimitRetry(url: URL, path: string): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(url, { headers: { authorization, accept: "application/json" } });
      if (response.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return response;
      const delay = retryDelayMs(response, attempt);
      logger.warn("Jira rate limited the request; waiting before retrying", { path, attempt: attempt + 1, delayMs: delay });
      await sleep(delay);
    }
  }

  async function get<T>(path: string, params: Record<string, string | undefined>, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);

    const response = await fetchWithRateLimitRetry(url, path);
    const text = await response.text();
    if (!response.ok) throw describeJiraError(response.status, path, text);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // Typically a proxy or SSO page that answered 200 instead of Jira.
      throw new Error(`Jira returned a non-JSON response for ${path}: ${excerpt(text)}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Unexpected Jira payload from ${path}: ${parsed.error.message}`, { cause: parsed.error });
    }
    return parsed.data;
  }

  /** Search embeds at most 100 changelog entries per issue; re-read the whole changelog for the few issues that have more. */
  async function completeChangelog(issue: RawJiraIssue): Promise<ChangelogHistory[]> {
    const embedded = issue.changelog?.histories ?? [];
    if (!issue.changelog || issue.changelog.total <= embedded.length) return embedded;

    logger.debug("Fetching full changelog", { issue: issue.key, total: issue.changelog.total });
    const path = `/rest/api/3/issue/${issue.id}/changelog`;
    const histories: ChangelogHistory[] = [];
    for (;;) {
      const page = await get(path, { startAt: String(histories.length), maxResults: String(PAGE_SIZE) }, changelogPageSchema);
      histories.push(...page.values);
      if (page.isLast) return histories;
      if (page.values.length === 0) throw new Error(`Jira reported more changelog entries for ${issue.key} but returned none at startAt=${histories.length}`);
    }
  }

  /** Pages through `/search/jql` by token, yielding each validated page. Fails rather than truncating silently. */
  async function* searchPages<T extends SearchPage>(jql: string, params: Record<string, string>, schema: z.ZodType<T>): AsyncIterable<T> {
    let nextPageToken: string | undefined;
    for (let page = 1; ; page += 1) {
      const result = await get("/rest/api/3/search/jql", { jql, ...params, maxResults: String(PAGE_SIZE), nextPageToken }, schema);
      logger.debug("Fetched issues page", { page, count: result.issues.length });
      yield result;

      if (result.isLast === false && !result.nextPageToken) {
        throw new Error(`Jira reported more issues but returned no nextPageToken (page ${page})`);
      }
      if (result.isLast || !result.nextPageToken) return;
      nextPageToken = result.nextPageToken;
    }
  }

  return {
    async *searchIssues(jql: string): AsyncIterable<JiraIssue> {
      const pages = searchPages(jql, { fields: ISSUE_FIELDS.join(","), expand: "changelog" }, searchPageSchema);
      for await (const page of pages) for (const raw of page.issues) yield toJiraIssue(raw, await completeChangelog(raw));
    },

    async *searchIssueKeys(jql: string): AsyncIterable<string> {
      for await (const page of searchPages(jql, { fields: "key" }, issueKeyPageSchema)) for (const issue of page.issues) yield issue.key;
    },

    async listStatusCategories() {
      const statuses = await get("/rest/api/3/status", {}, statusesSchema);
      return new Map(statuses.map((s) => [s.id, s.statusCategory.key]));
    },

    async listLinkedPullRequests(issueId: string): Promise<LinkedPullRequest[]> {
      const summary = await get("/rest/dev-status/latest/issue/summary", { issueId }, devStatusSummarySchema);
      const instanceTypes = Object.entries(summary.summary.pullrequest?.byInstanceType ?? {})
        .filter(([, instance]) => instance.count > 0)
        .map(([type]) => type);

      const linked: LinkedPullRequest[] = [];
      for (const applicationType of instanceTypes) {
        const result = await get(
          "/rest/dev-status/latest/issue/detail",
          { issueId, applicationType, dataType: "pullrequest" },
          devStatusDetailSchema,
        );
        for (const pr of result.detail.flatMap((d) => d.pullRequests)) {
          linked.push({
            url: pr.url,
            title: pr.name ?? null,
            status: pr.status,
            sourceBranch: pr.source?.branch ?? null,
            lastUpdate: pr.lastUpdate,
          });
        }
      }
      return linked;
    },
  };
}
