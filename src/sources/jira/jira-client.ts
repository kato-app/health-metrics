import { z } from "zod";
import type { Logger } from "../../logging/logger.js";
import {
  changelogHistorySchema,
  issueSchema,
  parseJiraDate,
  toJiraIssue,
  type JiraIssue,
  type JiraSource,
  type LinkedPullRequest,
  type StatusCategory,
} from "./source.js";

export interface JiraClientOptions {
  /** Site root, e.g. https://example.atlassian.net */
  readonly baseUrl: string;
  readonly email: string;
  readonly token: string;
  readonly logger: Logger;
  /** Injected for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

const PAGE_SIZE = 100;

/** Fields the application reads; requesting only these keeps search responses small. */
const ISSUE_FIELDS = ["summary", "issuetype", "project", "status", "resolution", "created", "resolutiondate"];

const searchPageSchema = z.object({
  issues: z.array(issueSchema),
  nextPageToken: z.string().optional(),
  isLast: z.boolean().optional(),
});

const changelogPageSchema = z.object({
  values: z.array(changelogHistorySchema),
  isLast: z.boolean(),
  nextPageToken: z.string().optional(),
});

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
    pullrequest: z
      .object({ byInstanceType: z.record(z.string(), z.object({ count: z.number(), name: z.string().optional() })) })
      .optional(),
  }),
});

const devStatusDetailSchema = z.object({
  detail: z.array(
    z.object({
      pullRequests: z
        .array(
          z.object({
            url: z.string(),
            name: z.string().nullable().optional(),
            status: z.string(),
            lastUpdate: z.string(),
            source: z.object({ branch: z.string().nullable().optional() }).optional(),
          }),
        )
        .default([]),
    }),
  ),
});

/** Turns a failed Jira call into an error that says what to check. */
export function describeJiraError(status: number, path: string, body: string): Error {
  const hints: Record<number, string> = {
    401: "Check ATLASSIAN_EMAIL and ATLASSIAN_TOKEN; the token may have expired",
    403: "The Jira user lacks permission for this resource (Browse Projects on the configured projects)",
    404: "Check ATLASSIAN_BASE_URL and the configured Jira project keys",
    410: "This Jira endpoint has been retired; the client needs updating",
  };
  const hint = hints[status];
  const detail = body.length > 300 ? `${body.slice(0, 300)}…` : body;
  return new Error(`Jira request failed (HTTP ${status}) for ${path}: ${detail}${hint ? `. ${hint}` : ""}`);
}

/** `JiraSource` for Jira Cloud using basic auth with an API token. */
export function createJiraClient(options: JiraClientOptions): JiraSource {
  const logger = options.logger.child({ source: "jira" });
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const authorization = `Basic ${Buffer.from(`${options.email}:${options.token}`).toString("base64")}`;

  async function get<T>(path: string, params: Record<string, string | undefined>, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);

    const response = await fetchImpl(url, { headers: { authorization, accept: "application/json" } });
    const text = await response.text();
    if (!response.ok) throw describeJiraError(response.status, path, text);

    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(`Unexpected Jira payload from ${path}: ${parsed.error.message}`, { cause: parsed.error });
    }
    return parsed.data;
  }

  /** Search returns at most 100 changelog entries per issue; fetch the rest for the few issues that have more. */
  async function completeChangelog(issue: z.infer<typeof issueSchema>): Promise<z.infer<typeof changelogHistorySchema>[]> {
    const embedded = issue.changelog?.histories ?? [];
    if (!issue.changelog || issue.changelog.total <= embedded.length) return embedded;

    logger.debug("Fetching full changelog", { issue: issue.key, total: issue.changelog.total });
    const histories: z.infer<typeof changelogHistorySchema>[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await get(`/rest/api/3/issue/${issue.id}/changelog`, { maxResults: String(PAGE_SIZE), nextPageToken }, changelogPageSchema);
      histories.push(...page.values);
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
    } while (nextPageToken);
    return histories;
  }

  return {
    async *searchIssues(jql: string): AsyncIterable<JiraIssue> {
      let nextPageToken: string | undefined;
      let page = 0;
      do {
        page += 1;
        const result = await get(
          "/rest/api/3/search/jql",
          { jql, fields: ISSUE_FIELDS.join(","), expand: "changelog", maxResults: String(PAGE_SIZE), nextPageToken },
          searchPageSchema,
        );
        logger.debug("Fetched issues page", { page, count: result.issues.length });
        for (const raw of result.issues) yield toJiraIssue(raw, await completeChangelog(raw));
        nextPageToken = result.isLast === true ? undefined : result.nextPageToken;
      } while (nextPageToken);
    },

    async listStatusCategories() {
      const statuses = await get("/rest/api/3/status", {}, statusesSchema);
      return new Map(statuses.map((s) => [s.id, s.statusCategory.key as StatusCategory | string]));
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
        for (const d of result.detail) {
          for (const pr of d.pullRequests) {
            linked.push({
              url: pr.url,
              title: pr.name ?? null,
              status: pr.status,
              sourceBranch: pr.source?.branch ?? null,
              lastUpdate: parseJiraDate(pr.lastUpdate),
            });
          }
        }
      }
      return linked;
    },
  };
}
