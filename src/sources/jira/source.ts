import { z } from "zod";

/**
 * Jira's three status categories. Every workflow status belongs to exactly one,
 * which is what lets "started" and "done" mean the same thing across projects
 * with different status names.
 */
export type StatusCategory = "new" | "indeterminate" | "done";

/** Jira writes timestamps like `2026-03-01T12:00:00.000+0000`; normalise to a Date. */
export function parseJiraDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Not a valid Jira date: ${value}`);
  return date;
}

const jiraDate = z.string().transform(parseJiraDate);

const changelogItemSchema = z.object({
  field: z.string(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  fromString: z.string().nullable().optional(),
  toString: z.string().nullable().optional(),
});

export const changelogHistorySchema = z.object({
  created: jiraDate,
  items: z.array(changelogItemSchema),
});

/** The subset of a Jira issue the application relies on, as returned by search or issue endpoints. */
export const issueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.object({
    summary: z.string(),
    issuetype: z.object({ name: z.string(), subtask: z.boolean() }),
    project: z.object({ key: z.string() }),
    status: z.object({ name: z.string(), statusCategory: z.object({ key: z.string() }) }),
    resolution: z.object({ name: z.string() }).nullable(),
    created: jiraDate,
    resolutiondate: jiraDate.nullable(),
  }),
  changelog: z
    .object({
      total: z.number().int(),
      histories: z.array(changelogHistorySchema),
    })
    .optional(),
});

/** One status change, oldest first when listed. `toStatusId` is looked up in the status map for its category. */
export interface StatusTransition {
  readonly at: Date;
  readonly fromStatusId: string | null;
  readonly toStatusId: string | null;
  readonly fromStatus: string | null;
  readonly toStatus: string | null;
}

export interface JiraIssue {
  readonly id: string;
  readonly key: string;
  readonly projectKey: string;
  readonly type: string;
  readonly isSubtask: boolean;
  readonly summary: string;
  readonly status: string;
  readonly statusCategory: StatusCategory | string;
  readonly resolution: string | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
  /** Every status change in the issue's history, oldest first. */
  readonly statusTransitions: readonly StatusTransition[];
}

/** Converts a raw issue plus its complete changelog histories into the domain shape. */
export function toJiraIssue(
  raw: z.infer<typeof issueSchema>,
  histories: readonly z.infer<typeof changelogHistorySchema>[],
): JiraIssue {
  const statusTransitions = histories
    .flatMap((history) =>
      history.items
        .filter((item) => item.field === "status")
        .map((item) => ({
          at: history.created,
          fromStatusId: item.from ?? null,
          toStatusId: item.to ?? null,
          fromStatus: item.fromString ?? null,
          toStatus: item.toString ?? null,
        })),
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  return {
    id: raw.id,
    key: raw.key,
    projectKey: raw.fields.project.key,
    type: raw.fields.issuetype.name,
    isSubtask: raw.fields.issuetype.subtask,
    summary: raw.fields.summary,
    status: raw.fields.status.name,
    statusCategory: raw.fields.status.statusCategory.key,
    resolution: raw.fields.resolution?.name ?? null,
    createdAt: raw.fields.created,
    resolvedAt: raw.fields.resolutiondate,
    statusTransitions,
  };
}

/** A pull request Jira has linked to an issue through the GitHub integration. */
export interface LinkedPullRequest {
  /** Full GitHub URL, e.g. https://github.com/kato-app/kato/pull/4193 */
  readonly url: string;
  readonly title: string | null;
  /** Jira reports OPEN, MERGED or DECLINED. */
  readonly status: string;
  readonly sourceBranch: string | null;
  readonly lastUpdate: Date;
}

/** Read-only access to Jira Cloud. */
export interface JiraSource {
  /** Issues matching a JQL query, with their complete status changelog. Pages lazily. */
  searchIssues(jql: string): AsyncIterable<JiraIssue>;
  /** Every workflow status in the site, keyed by status id, mapped to its category. */
  listStatusCategories(): Promise<ReadonlyMap<string, StatusCategory | string>>;
  /** Pull requests the GitHub integration has linked to the issue with this numeric id. */
  listLinkedPullRequests(issueId: string): Promise<LinkedPullRequest[]>;
}
