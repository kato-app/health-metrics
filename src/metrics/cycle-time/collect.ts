import type { JiraProject } from "../../config/schema.js";
import { compareRows, type CollectContext, type MetricRow } from "../../core/metric.js";
import { MS_PER_DAY, newestSheetDate, startOfUtcDay } from "../../core/sheet-date.js";
import { parsePullRequestUrl, pullRequestKey, repoFullName, type GitHubSource, type PullRequestRef, type RepoRef } from "../../sources/github/source.js";
import type { Logger } from "../../logging/logger.js";
import type { JiraIssue, JiraSource, LinkedPullRequest } from "../../sources/jira/source.js";
import { extractIssueKeys, mentionsIssueKey } from "./issue-keys.js";
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

/** A linked pull request in a collected repository, with the text Jira gives us to attribute it. */
interface CandidatePullRequest {
  readonly ref: PullRequestRef;
  readonly status: string;
  readonly title: string | null;
  readonly sourceBranch: string | null;
}

/**
 * Linked pull requests that live in one of the repositories we collect from,
 * excluding declined ones. Jira reports OPEN, MERGED or DECLINED; anything
 * else it may add (a draft, say) counts as not merged yet.
 */
function relevantPullRequests(linked: readonly LinkedPullRequest[], repos: readonly RepoRef[]): CandidatePullRequest[] {
  const known = new Set(repos.map(repoFullName));
  return linked.flatMap((pr) => {
    const ref = parsePullRequestUrl(pr.url);
    if (!ref || !known.has(repoFullName(ref.repo)) || pr.status === "DECLINED") return [];
    return [{ ref, status: pr.status, title: pr.title, sourceBranch: pr.sourceBranch }];
  });
}

/** Branch name and title, whichever Jira reported. */
function attributionTexts(pr: CandidatePullRequest): string[] {
  return [pr.sourceBranch, pr.title].filter((text) => text !== null);
}

/**
 * Jira links a pull request to every issue its commits or description mention,
 * so follow-up work under another ticket can attach itself months later and
 * drag this issue's release date forward. Prefer the pull requests whose
 * branch or title name this issue; only if none do, fall back to everything
 * Jira linked (some teams put the key in commit messages alone). Applied before
 * the open/merged split, so a dropped pull request neither ends the cycle nor,
 * while open, defers the issue. Warns when a dropped pull request names another
 * configured issue, so the attribution can be checked against both tickets.
 */
function ownPullRequests(issue: JiraIssue, candidates: readonly CandidatePullRequest[], projectKeys: readonly string[], logger: Logger): readonly CandidatePullRequest[] {
  const own = candidates.filter((pr) => attributionTexts(pr).some((text) => mentionsIssueKey(text, issue.key)));
  if (own.length === 0) return candidates;

  const dropped = candidates
    .filter((pr) => !own.includes(pr))
    // Joined on a newline so a key cannot straddle branch and title; a dropped pull request never names `issue.key`.
    .map((pr) => ({ pr, keys: extractIssueKeys(attributionTexts(pr).join("\n"), projectKeys) }))
    .filter(({ keys }) => keys.length > 0);
  if (dropped.length > 0) {
    logger.warn("Ignoring linked pull requests that belong to other issues", {
      issue: issue.key,
      kept: own.map((pr) => pullRequestKey(pr.ref)),
      ignored: dropped.map(({ pr, keys }) => `${pullRequestKey(pr.ref)} (${keys.join(", ")})`),
    });
  }
  return own;
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
  const projectKeys = options.projects.map((p) => p.key);
  const excludedResolutions = new Set(options.excludedResolutions.map((r) => r.toLowerCase()));

  logger.debug("Collecting cycle time", {
    startDate: startDate.toISOString(),
    watermark: watermark?.toISOString() ?? null,
    resolvedSince: resolvedSince.toISOString(),
    knownIssues: knownKeys.size,
  });

  const [categories, index] = await Promise.all([jira.listStatusCategories(), buildReleaseIndex(github, options.repos, startDate, logger)]);
  reportUnlinkedPullRequests(index.shipped, watermark, projectKeys, logger);

  const jql =
    `project in (${projectKeys.join(", ")}) AND statusCategory = Done ` +
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

    const linked = relevantPullRequests(await jira.listLinkedPullRequests(issue.id), options.repos);
    const pullRequests = ownPullRequests(issue, linked, projectKeys, logger);
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
  return rows.sort(compareRows("released_at", "issue_key"));
}
