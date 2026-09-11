import { parsePullRequestUrl, type PullRequestRef } from "./source.js";

/** A pull request mentioned in GitHub's generated release notes. */
export interface ReleaseNotePullRequest {
  readonly ref: PullRequestRef;
  readonly title: string;
}

/**
 * One line per merged pull request, as GitHub's "Generate release notes" writes them:
 * `* <title> by @<login> in https://github.com/<owner>/<repo>/pull/<n>`
 */
const NOTE_LINE = /^\s*[*-]\s+(.+?)\s+by\s+@\S+\s+in\s+(https:\/\/github\.com\/\S+\/pull\/\d+)\s*$/gm;

/** Pull requests listed in a release body, in order, each at most once. */
export function parseReleaseNotes(body: string | null | undefined): ReleaseNotePullRequest[] {
  if (!body) return [];
  const seen = new Set<string>();
  const result: ReleaseNotePullRequest[] = [];
  for (const [, title, url] of body.matchAll(NOTE_LINE)) {
    const ref = parsePullRequestUrl(url!);
    if (!ref || seen.has(url!)) continue;
    seen.add(url!);
    result.push({ ref, title: title!.trim() });
  }
  return result;
}

/**
 * Titles of pull requests that exist to move code between long-lived branches
 * or cut a version, which never carry an issue key and are not worth
 * flagging as unlinked. Matches "Main to Release", "Release => Main v77.10",
 * "v77.9", "Release v2.25.1", "Merge pull request #555 from ...".
 */
const HOUSEKEEPING_TITLE =
  /^(?:(?:main|release|develop|staging)\s*(?:=>|->|to|into)\s*(?:main|release|develop|staging)\b|v\d+(?:\.\d+)*\b|\d+(?:\.\d+)+\b|release(?:\s+v?\d[\w.]*)?$|merge (?:pull request|branch)\b)/i;

export function isHousekeepingPullRequest(title: string): boolean {
  return HOUSEKEEPING_TITLE.test(title.trim());
}
