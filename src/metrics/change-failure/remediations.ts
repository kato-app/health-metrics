import { MS_PER_DAY } from "../../core/sheet-date.js";
import type { Logger } from "../../logging/logger.js";
import { isHousekeepingPullRequest } from "../../sources/github/release-notes.js";
import { parsePullRequestUrl, pullRequestKey, repoFullName, type RepoRef } from "../../sources/github/source.js";
import type { JiraSource } from "../../sources/jira/source.js";
import { extractIssueKeys } from "../cycle-time/issue-keys.js";
import type { ReleaseIndex, ReleaseRef, ShippedPullRequest } from "../cycle-time/release-index.js";
import { findPatchBase, isHotfixTitle, isPatchTag, isRevertTitle } from "./signals.js";
import { ReleaseTimeline, releaseKey } from "./timeline.js";

/** How we know a release needed fixing. One sheet column per signal. */
export type RemediationSignal = "hotfix" | "revert" | "patch_tag" | "jira_regression";

/** Evidence that a release (the map key) needed remediation. */
export interface Remediation {
  readonly signal: RemediationSignal;
  /** Human-readable pointer: `kato#3186 "Hotfix for uuid migration"`, `v73.12.1`, `GR-210`. */
  readonly evidence: string;
  /** The release that shipped the fix, when it has shipped. */
  readonly remediatedBy: ReleaseRef | null;
  /** When the failure became known: the fix's release for hotfixes, the bug's creation for Jira regressions. */
  readonly at: Date;
}

/** A hotfix, revert or patch release that could not be pinned on any earlier release. */
export interface UnclaimedRemediation {
  readonly signal: Exclude<RemediationSignal, "jira_regression">;
  readonly evidence: string;
  readonly author: string | null;
  readonly release: ReleaseRef;
  readonly reason: string;
}

export interface RemediationOptions {
  readonly projectKeys: readonly string[];
  /** Releases before this are not indexed, so nothing can be attributed to them. */
  readonly startDate: Date;
  /** A key-less hotfix is pinned on the previous release only if that release is at most this many days older. */
  readonly keylessAttributionDays: number;
  /** Jira label that marks a bug as a regression caused by a recent release. Affects Version counts too. */
  readonly regressionLabel: string;
}

export interface RemediationReport {
  readonly byRelease: ReadonlyMap<string, readonly Remediation[]>;
  readonly unclaimed: readonly UnclaimedRemediation[];
  /** Regression bugs that could not be tied to a repository because no merged pull request is linked. */
  readonly regressionBugsWithoutPullRequest: readonly string[];
}

/** The release a fix is pinned on, or why it cannot be pinned on any. */
type Attribution = { readonly failed: ReleaseRef } | { readonly reason: string };

/**
 * Finds every remediation in the indexed releases and attributes each to the
 * release it fixed, in the agreed order of trust:
 *
 * 1. Hotfix or revert pull requests in a release's notes. If the title names
 *    a Jira issue that exists, the failed release is the one live when that
 *    issue was created. Otherwise, if the fixing release is a patch tag, its
 *    base version failed. Otherwise the immediately preceding release failed,
 *    but only when it is recent enough to be a credible cause; anything else
 *    is reported as unclaimed rather than guessed.
 * 2. Patch tags (`v73.36.1` fixes `v73.36`), independent of what they contain.
 * 3. Jira bugs marked as regressions (label or Affects Version) with a merged
 *    pull request in a collected repository: the release live in that
 *    repository when the bug was created failed.
 */
export async function findRemediations(
  index: ReleaseIndex,
  jira: JiraSource,
  repos: readonly RepoRef[],
  options: RemediationOptions,
  logger: Logger,
): Promise<RemediationReport> {
  const timeline = new ReleaseTimeline(index.releases);
  const byRelease = new Map<string, Remediation[]>();
  const unclaimed: UnclaimedRemediation[] = [];

  const attribute = (failed: ReleaseRef, remediation: Remediation) => {
    const key = releaseKey(failed);
    const list = byRelease.get(key);
    if (list) list.push(remediation);
    else byRelease.set(key, [remediation]);
  };
  /** Records a fix shipped in `fixing` against the release it is attributed to, or as unclaimed. */
  const record = (signal: UnclaimedRemediation["signal"], evidence: string, fixing: ReleaseRef, author: string | null, target: Attribution) => {
    if ("failed" in target) attribute(target.failed, { signal, evidence, remediatedBy: fixing, at: fixing.publishedAt });
    else unclaimed.push({ signal, evidence, author, release: fixing, reason: target.reason });
  };

  // 1. Hotfix and revert pull requests.
  for (const pr of index.shipped) {
    if (isHousekeepingPullRequest(pr.title)) continue;
    const signal = isRevertTitle(pr.title) ? "revert" : isHotfixTitle(pr.title) ? "hotfix" : undefined;
    if (!signal) continue;
    record(signal, `${pullRequestKey(pr.ref)} "${pr.title}"`, pr.release, pr.author, await attributePullRequest(pr, timeline, jira, options));
  }

  // 2. Patch tags.
  for (const release of index.releases) {
    if (!isPatchTag(release.tag)) continue;
    const base = findPatchBase(release, timeline.releasesOf(release.repo));
    record("patch_tag", release.tag, release, null, base ? { failed: base } : { reason: "no base release for this patch tag is indexed since the start date" });
  }

  // 3. Jira regressions.
  const regressionBugsWithoutPullRequest: string[] = [];
  const collected = new Set(repos.map(repoFullName));
  const jql =
    `project in (${options.projectKeys.join(", ")}) AND issuetype = Bug AND created >= "${options.startDate.toISOString().slice(0, 10)}" ` +
    `AND (labels = "${options.regressionLabel}" OR affectedVersion is not EMPTY)`;
  for await (const bug of jira.searchIssueSummaries(jql)) {
    const fix = (await jira.listLinkedPullRequests(bug.id))
      .filter((pr) => pr.status === "MERGED")
      .map((pr) => parsePullRequestUrl(pr.url))
      .find((ref) => ref && collected.has(repoFullName(ref.repo)));
    if (!fix) {
      regressionBugsWithoutPullRequest.push(bug.key);
      continue;
    }
    const failed = timeline.liveAt(fix.repo, bug.createdAt);
    if (!failed) {
      logger.debug("Regression bug predates every indexed release of its repository", { bug: bug.key, repo: repoFullName(fix.repo) });
      continue;
    }
    attribute(failed, { signal: "jira_regression", evidence: bug.key, remediatedBy: index.releaseFor(fix) ?? null, at: bug.createdAt });
  }

  if (regressionBugsWithoutPullRequest.length > 0) {
    logger.info("Regression bugs skipped because no merged pull request links them to a repository", { bugs: regressionBugsWithoutPullRequest });
  }
  logger.info("Attributed remediations", {
    releasesWithRemediation: byRelease.size,
    remediations: [...byRelease.values()].reduce((n, list) => n + list.length, 0),
    unclaimed: unclaimed.length,
  });
  return { byRelease, unclaimed, regressionBugsWithoutPullRequest };
}

/** Which earlier release a hotfix or revert pull request fixed, or why that cannot be said. */
async function attributePullRequest(pr: ShippedPullRequest, timeline: ReleaseTimeline, jira: JiraSource, options: RemediationOptions): Promise<Attribution> {
  const fixing = pr.release;

  // The first key in the title that Jira knows decides; `AWA-000`-style placeholders do not exist and are skipped.
  for (const key of extractIssueKeys(pr.title, options.projectKeys)) {
    const issue = await jira.getIssue(key);
    if (!issue) continue;
    const live = timeline.liveAt(fixing.repo, issue.createdAt);
    if (!live) return { reason: `${key} was created before any indexed release of ${repoFullName(fixing.repo)}` };
    if (live.publishedAt >= fixing.publishedAt) return { reason: `${key} was created after the fixing release ${fixing.tag}` };
    return { failed: live };
  }

  const base = findPatchBase(fixing, timeline.releasesOf(fixing.repo));
  if (base) return { failed: base };

  const previous = timeline.previous(fixing);
  if (!previous) return { reason: `no earlier release of ${repoFullName(fixing.repo)} is indexed` };
  const ageDays = (fixing.publishedAt.getTime() - previous.publishedAt.getTime()) / MS_PER_DAY;
  if (ageDays > options.keylessAttributionDays) {
    return { reason: `no issue key, and the previous release ${previous.tag} is ${ageDays.toFixed(1)} days older than the ${options.keylessAttributionDays}-day limit` };
  }
  return { failed: previous };
}
