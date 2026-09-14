import type { Logger } from "../../logging/logger.js";
import { UNLINKED_REASONS, classifyUnlinked, type UnlinkedPullRequest } from "../unlinked-prs/classify.js";
import type { ShippedPullRequest } from "./release-index.js";

/**
 * Summarises, for the pull requests shipped in releases published after
 * `since` (all of them when undefined), how many cycle time could not
 * attribute to a configured Jira issue and why. One `info` line; the full,
 * always-current list lives in the `unlinked-prs` tab, which also checks Jira
 * for keyed pull requests that were never linked (this summary does not).
 */
export function reportUnlinkedPullRequests(
  shipped: readonly ShippedPullRequest[],
  since: Date | undefined,
  projectKeys: readonly string[],
  logger: Logger,
): UnlinkedPullRequest[] {
  const audited = since ? shipped.filter((pr) => pr.release.publishedAt > since) : shipped;
  const unlinked = classifyUnlinked(audited, projectKeys, new Set());

  const otherProjects: Record<string, number> = {};
  for (const { reason, issueKeys } of unlinked) {
    if (reason !== UNLINKED_REASONS.unknownProject) continue;
    const project = issueKeys[0]!.split("-")[0]!;
    otherProjects[project] = (otherProjects[project] ?? 0) + 1;
  }

  logger.info("Shipped pull requests cycle time cannot attribute; see the unlinked-prs tab for the list", {
    audited: audited.length,
    noIssueKey: unlinked.filter((u) => u.reason === UNLINKED_REASONS.noKey).length,
    otherProjects,
  });
  return unlinked;
}
