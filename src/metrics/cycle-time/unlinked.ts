import type { Logger } from "../../logging/logger.js";
import { isHousekeepingPullRequest } from "../../sources/github/release-notes.js";
import { pullRequestKey } from "../../sources/github/source.js";
import { extractIssueKeys } from "./issue-keys.js";
import type { ShippedPullRequest } from "./release-index.js";

/** Anything shaped like an issue key from a project we do not collect, e.g. `Awa 10288`. Two digits or more to avoid "Phase 2". */
const OTHER_PROJECT_KEY = /\b([A-Z][A-Za-z]{1,9})[-_ ]?\d{2,7}\b/;

export interface UnlinkedReport {
  /** Shipped pull requests with no recognisable issue key at all. Fix these at the source. */
  readonly unlinked: readonly ShippedPullRequest[];
  /** Pull requests keyed to projects outside config, counted per project key. */
  readonly otherProjects: Readonly<Record<string, number>>;
}

/**
 * Audits the pull requests shipped in releases published after `since` (all of
 * them when undefined) and logs the ones the cycle-time metric cannot attribute
 * to a configured Jira issue: one line per pull request whose title carries no
 * issue key, and one summary line for pull requests keyed to other projects.
 * Housekeeping pull requests (branch syncs, version cuts) are ignored.
 */
export function reportUnlinkedPullRequests(
  shipped: readonly ShippedPullRequest[],
  since: Date | undefined,
  projectKeys: readonly string[],
  logger: Logger,
): UnlinkedReport {
  const unlinked: ShippedPullRequest[] = [];
  const otherProjects: Record<string, number> = {};

  for (const pr of shipped) {
    if (since && pr.release.publishedAt <= since) continue;
    if (isHousekeepingPullRequest(pr.title)) continue;
    if (extractIssueKeys(pr.title, projectKeys).length > 0) continue;

    const other = OTHER_PROJECT_KEY.exec(pr.title)?.[1]?.toUpperCase();
    if (other) otherProjects[other] = (otherProjects[other] ?? 0) + 1;
    else unlinked.push(pr);
  }

  for (const pr of unlinked) {
    logger.warn("Released pull request has no issue key in its title; add one so cycle time can attribute it", {
      pullRequest: pullRequestKey(pr.ref),
      title: pr.title,
      release: pr.release.tag,
      releasedAt: pr.release.publishedAt.toISOString(),
    });
  }
  if (Object.keys(otherProjects).length > 0) {
    logger.info("Released pull requests keyed to Jira projects outside config.json", { otherProjects });
  }

  return { unlinked, otherProjects };
}
