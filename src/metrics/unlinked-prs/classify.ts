import { isHousekeepingPullRequest } from "../../sources/github/release-notes.js";
import { extractIssueKeys } from "../cycle-time/issue-keys.js";
import type { ShippedPullRequest } from "../cycle-time/release-index.js";

/** Why cycle time cannot attribute a shipped pull request to a configured Jira issue. Written to the sheet verbatim. */
export const UNLINKED_REASONS = {
  noKey: "No issue key in title",
  unknownProject: "Issue key is not a configured Jira project",
  notLinkedInJira: "Jira issue has no linked pull request",
} as const;

export type UnlinkedReason = (typeof UNLINKED_REASONS)[keyof typeof UNLINKED_REASONS];

export interface UnlinkedPullRequest {
  readonly pullRequest: ShippedPullRequest;
  readonly reason: UnlinkedReason;
  /** Issue keys found in the title, normalised; empty when there are none. */
  readonly issueKeys: readonly string[];
}

/**
 * An issue key from a project we do not collect: strict (`AWA-10290`) anywhere
 * in the title, or branch-derived (`Awa 10288 kf availability`) only at the
 * start and with two digits or more, so that "Upgrade to Node 22" and
 * "Phase 2 rollout" are reported as key-less rather than as projects.
 */
const OTHER_PROJECT_KEY = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b|^([A-Z][A-Za-z]{1,9})[-_ ]?(\d{2,7})\b/;

/**
 * Sorts shipped pull requests into the ones cycle time cannot attribute and why.
 * Housekeeping pull requests (branch syncs, version cuts) are never reported.
 * A pull request whose title names a configured project's issue is linked unless
 * every such issue is in `issuesWithoutLinks`, the keys Jira reports as having
 * no development information at all.
 */
export function classifyUnlinked(
  shipped: readonly ShippedPullRequest[],
  projectKeys: readonly string[],
  issuesWithoutLinks: ReadonlySet<string>,
): UnlinkedPullRequest[] {
  const result: UnlinkedPullRequest[] = [];
  for (const pullRequest of shipped) {
    if (isHousekeepingPullRequest(pullRequest.title)) continue;

    const issueKeys = extractIssueKeys(pullRequest.title, projectKeys);
    if (issueKeys.length > 0) {
      if (issueKeys.every((key) => issuesWithoutLinks.has(key))) {
        result.push({ pullRequest, reason: UNLINKED_REASONS.notLinkedInJira, issueKeys });
      }
      continue;
    }

    const other = OTHER_PROJECT_KEY.exec(pullRequest.title);
    if (other) {
      const key = `${(other[1] ?? other[3])!.toUpperCase()}-${other[2] ?? other[4]}`;
      result.push({ pullRequest, reason: UNLINKED_REASONS.unknownProject, issueKeys: [key] });
    } else {
      result.push({ pullRequest, reason: UNLINKED_REASONS.noKey, issueKeys: [] });
    }
  }
  return result;
}
