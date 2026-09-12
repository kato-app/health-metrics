import type { MetricRow } from "../../core/metric.js";
import { MS_PER_DAY, formatSheetDate } from "../../core/sheet-date.js";
import type { JiraIssue, StatusCategory } from "../../sources/jira/source.js";

export const COLUMNS = [
  "released_at",
  "project",
  "team",
  "issue_key",
  "issue_type",
  "summary",
  "created_at",
  "started_at",
  "done_at",
  "last_merged_at",
  "pr_count",
  "repos",
  "release_tags",
  "cycle_time_days",
  "lead_time_days",
] as const;

/** Everything known about one delivered issue, ready to become a row. */
export interface DeliveredIssue {
  readonly issue: JiraIssue;
  readonly team: string;
  /** When the release containing the issue's last pull request was published. The end of the cycle. */
  readonly releasedAt: Date;
  readonly startedAt: Date | null;
  readonly doneAt: Date | null;
  readonly lastMergedAt: Date | null;
  readonly pullRequests: number;
  readonly repos: readonly string[];
  readonly releaseTags: readonly string[];
}

/** Calendar days between two instants, to two decimal places. Weekends count. */
export function calendarDays(from: Date, to: Date): number {
  return Math.round(((to.getTime() - from.getTime()) / MS_PER_DAY) * 100) / 100;
}

/**
 * Start of cycle: the first time the issue entered one of `startStatuses`
 * (by name, case-insensitive). Falls back to the first status in Jira's
 * "In Progress" category so a project with differently named statuses still
 * gets a start. Null if the issue never left the To Do category.
 */
export function findStartedAt(
  issue: JiraIssue,
  startStatuses: readonly string[],
  categories: ReadonlyMap<string, StatusCategory | string>,
): Date | null {
  const wanted = new Set(startStatuses.map((s) => s.toLowerCase()));
  const byName = issue.statusTransitions.find((t) => t.toStatus !== null && wanted.has(t.toStatus.toLowerCase()));
  if (byName) return byName.at;
  const byCategory = issue.statusTransitions.find((t) => t.toStatusId !== null && categories.get(t.toStatusId) === "indeterminate");
  return byCategory?.at ?? null;
}

/** The last time the issue entered a Done-category status, falling back to Jira's resolution date. */
export function findDoneAt(issue: JiraIssue, categories: ReadonlyMap<string, StatusCategory | string>): Date | null {
  const done = issue.statusTransitions.filter((t) => t.toStatusId !== null && categories.get(t.toStatusId) === "done").at(-1);
  return done?.at ?? issue.resolvedAt;
}

export function toRow(delivered: DeliveredIssue): MetricRow {
  const { issue, releasedAt, startedAt } = delivered;
  return {
    released_at: formatSheetDate(releasedAt),
    project: issue.projectKey,
    team: delivered.team,
    issue_key: issue.key,
    issue_type: issue.type,
    summary: issue.summary,
    created_at: formatSheetDate(issue.createdAt),
    started_at: startedAt ? formatSheetDate(startedAt) : null,
    done_at: delivered.doneAt ? formatSheetDate(delivered.doneAt) : null,
    last_merged_at: delivered.lastMergedAt ? formatSheetDate(delivered.lastMergedAt) : null,
    pr_count: delivered.pullRequests,
    repos: delivered.repos.join(", "),
    release_tags: delivered.releaseTags.join(", "),
    cycle_time_days: startedAt ? calendarDays(startedAt, releasedAt) : null,
    lead_time_days: calendarDays(issue.createdAt, releasedAt),
  };
}
