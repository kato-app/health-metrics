import type { JiraProject } from "../../config/schema.js";
import type { CollectContext, MetricRow } from "../../core/metric.js";
import { MS_PER_DAY, newestSheetDate, startOfUtcDay } from "../../core/sheet-date.js";
import { parsePullRequestUrl, pullRequestKey, repoFullName, type GitHubSource, type PullRequestRef, type RepoRef } from "../../sources/github/source.js";
import type { JiraIssue, JiraSource, LinkedPullRequest } from "../../sources/jira/source.js";
import { buildReleaseIndex, type ReleaseRef } from "./release-index.js";
import { findDoneAt, findStartedAt, toRow, type DeliveredIssue } from "./transform.js";
import { reportUnlinkedPullRequests } from "./unlinked.js";

/**
 * How far behind the newest `released_at` in the sheet we re-query Jira.
 *
 * An issue is only written once its last pull request has shipped, which can
 * be long after Jira marked it Done. Re-reading issues resolved in this window
 * (and skipping keys already in the sheet before any expensive lookups) lets a
 * deferred issue be picked up when its release finally appears.
 */
export const DEFAULT_GRACE_DAYS = 90;

export interface CycleTimeSources {
  readonly jira: JiraSource;
  readonly github: GitHubSource;
}

export interface CollectOptions {
  readonly projects: readonly JiraProject[];
  readonly repos: readonly RepoRef[];
  /** `YYYY-MM-DD`; issues released before this UTC day are ignored. */
  readonly startDate: string;
  readonly startStatuses: readonly string[];
  readonly excludedResolutions: readonly string[];
  readonly graceDays?: number;
}

/** Why an issue produced no row this run. Counted and logged so the gaps are visible. */
type Skip = "subtask" | "excludedResolution" | "alreadyInSheet" | "noMergedPullRequests" | "openPullRequests" | "unreleasedPullRequests" | "beforeStartDate";

function byReleasedThenKey(a: MetricRow, b: MetricRow): number {
  if (a.released_at !== b.released_at) return String(a.released_at) < String(b.released_at) ? -1 : 1;
  return String(a.issue_key) < String(b.issue_key) ? -1 : 1;
}

/**
 * Linked pull requests that live in one of the repositories we collect from,
 * excluding declined ones. Jira reports OPEN, MERGED or DECLINED; anything
 * else it may add (a draft, say) counts as not merged yet.
 */
function relevantPullRequests(linked: readonly LinkedPullRequest[], repos: readonly RepoRef[]): { ref: PullRequestRef; status: string }[] {
  const known = new Set(repos.map(repoFullName));
  return linked.flatMap((pr) => {
    const ref = parsePullRequestUrl(pr.url);
    if (!ref || !known.has(repoFullName(ref.repo)) || pr.status === "DECLINED") return [];
    return [{ ref, status: pr.status }];
  });
}

function latest(dates: readonly Date[]): Date {
  return new Date(Math.max(...dates.map((d) => d.getTime())));
}

export async function collectCycleTime(sources: CycleTimeSources, options: CollectOptions, context: CollectContext): Promise<MetricRow[]> {
  const { jira, github } = sources;
  const { logger, existingRows } = context;
  const startDate = startOfUtcDay(options.startDate);
  const sheetWatermark = newestSheetDate(existingRows, "released_at");
  if (!sheetWatermark && existingRows.length > 0) {
    logger.warn("Existing rows have no readable released_at; querying Jira from the start date", { existingRows: existingRows.length });
  }
  const watermark = context.full ? undefined : sheetWatermark;
  const graceMs = (options.graceDays ?? DEFAULT_GRACE_DAYS) * MS_PER_DAY;
  const resolvedSince = watermark ? new Date(Math.max(startDate.getTime(), watermark.getTime() - graceMs)) : startDate;
  const knownKeys = new Set(existingRows.map((row) => String(row.issue_key)));
  const teams = new Map(options.projects.map((p) => [p.key, p.team]));
  const excludedResolutions = new Set(options.excludedResolutions.map((r) => r.toLowerCase()));

  logger.debug("Collecting cycle time", {
    startDate: startDate.toISOString(),
    watermark: watermark?.toISOString() ?? null,
    resolvedSince: resolvedSince.toISOString(),
    knownIssues: knownKeys.size,
  });

  const [categories, index] = await Promise.all([jira.listStatusCategories(), buildReleaseIndex(github, options.repos, startDate, logger)]);
  reportUnlinkedPullRequests(index.shipped, watermark, options.projects.map((p) => p.key), logger);

  const jql =
    `project in (${options.projects.map((p) => p.key).join(", ")}) AND statusCategory = Done ` +
    `AND resolved >= "${resolvedSince.toISOString().slice(0, 10)}" ORDER BY resolved ASC`;

  const skips: Record<Skip, number> = { subtask: 0, excludedResolution: 0, alreadyInSheet: 0, noMergedPullRequests: 0, openPullRequests: 0, unreleasedPullRequests: 0, beforeStartDate: 0 };
  const skip = (issue: JiraIssue, reason: Skip, detail: Record<string, unknown> = {}): undefined => {
    skips[reason] += 1;
    logger.debug("Skipping issue", { issue: issue.key, reason, ...detail });
    return undefined;
  };

  async function deliver(issue: JiraIssue): Promise<DeliveredIssue | undefined> {
    if (issue.isSubtask) return skip(issue, "subtask");
    if (issue.resolution && excludedResolutions.has(issue.resolution.toLowerCase())) return skip(issue, "excludedResolution", { resolution: issue.resolution });
    if (knownKeys.has(issue.key)) return skip(issue, "alreadyInSheet");

    const pullRequests = relevantPullRequests(await jira.listLinkedPullRequests(issue.id), options.repos);
    const merged = pullRequests.filter((pr) => pr.status === "MERGED");
    const open = pullRequests.filter((pr) => pr.status !== "MERGED");
    if (open.length > 0) return skip(issue, "openPullRequests", { open: open.map((pr) => `${pullRequestKey(pr.ref)} ${pr.status}`) });
    if (merged.length === 0) return skip(issue, "noMergedPullRequests");

    const releases: ReleaseRef[] = [];
    for (const pr of merged) {
      const release = index.releaseFor(pr.ref);
      if (!release) return skip(issue, "unreleasedPullRequests", { pullRequest: pullRequestKey(pr.ref) });
      releases.push(release);
    }
    const releasedAt = latest(releases.map((r) => r.publishedAt));
    if (releasedAt < startDate) return skip(issue, "beforeStartDate");

    const details = await Promise.all(merged.map((pr) => github.getPullRequest(pr.ref)));
    const mergedAt = details.flatMap((d) => (d.merged_at ? [new Date(d.merged_at)] : []));

    return {
      issue,
      team: teams.get(issue.projectKey) ?? issue.projectKey,
      releasedAt,
      startedAt: findStartedAt(issue, options.startStatuses, categories),
      doneAt: findDoneAt(issue, categories),
      lastMergedAt: mergedAt.length ? latest(mergedAt) : null,
      pullRequests: merged.length,
      repos: [...new Set(merged.map((pr) => repoFullName(pr.ref.repo)))],
      releaseTags: [...new Set(releases.map((r) => `${r.repo.name}@${r.tag}`))],
    };
  }

  const rows: MetricRow[] = [];
  let seen = 0;
  let withoutStart = 0;
  for await (const issue of jira.searchIssues(jql)) {
    seen += 1;
    const delivered = await deliver(issue);
    if (!delivered) continue;
    if (!delivered.startedAt) withoutStart += 1;
    if (delivered.startedAt && delivered.startedAt > delivered.releasedAt) {
      // The code shipped before the ticket was started: usually a ticket raised after the fact,
      // or a pull request linked to the wrong issue. Kept in the sheet, but worth a look.
      logger.warn("Issue was released before it was started; check the ticket and its linked pull requests", {
        issue: issue.key,
        startedAt: delivered.startedAt.toISOString(),
        releasedAt: delivered.releasedAt.toISOString(),
      });
    }
    rows.push(toRow(delivered));
    knownKeys.add(issue.key);
  }

  logger.info("Collected delivered issues", { seen, added: rows.length, withoutStart, skipped: skips });
  return rows.sort(byReleasedThenKey);
}
