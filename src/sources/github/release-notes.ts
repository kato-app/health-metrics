import { parsePullRequestUrl, pullRequestKey, type PullRequestRef } from "./source.js";

/** A pull request mentioned in GitHub's generated release notes. */
export interface ReleaseNotePullRequest {
  readonly ref: PullRequestRef;
  readonly title: string;
  /** GitHub login of the pull request's author, as written after "by @". */
  readonly author: string;
}

/**
 * One line per merged pull request, as GitHub's "Generate release notes" writes them:
 * `* <title> by @<login> in https://github.com/<owner>/<repo>/pull/<n>`
 * The trailing token is any URL; `parsePullRequestUrl` decides whether it is a pull request.
 */
const NOTE_LINE = /^\s*[*-]\s+(.+?)\s+by\s+@(\S+)\s+in\s+(\S+)\s*$/gm;

/** Pull requests listed in a release body, in order, each at most once. */
export function parseReleaseNotes(body: string | null | undefined): ReleaseNotePullRequest[] {
  if (!body) return [];
  const byKey = new Map<string, ReleaseNotePullRequest>();
  for (const [, title, author, url] of body.matchAll(NOTE_LINE)) {
    const ref = parsePullRequestUrl(url!);
    if (!ref) continue;
    const key = pullRequestKey(ref);
    if (!byKey.has(key)) byKey.set(key, { ref, title: title!.trim(), author: author! });
  }
  return [...byKey.values()];
}

const BRANCH = String.raw`(?:main|release|develop|staging)`;
const VERSION = String.raw`v?\d+(?:\.\d+)*`;

/**
 * Titles of pull requests that exist to move code between long-lived branches
 * or cut a version, which never carry an issue key and are not worth flagging
 * as unlinked. Version titles must be the whole title so that feature work
 * such as "V2 endpoints" is still flagged.
 */
const HOUSEKEEPING_TITLE = new RegExp(
  [
    String.raw`^${BRANCH}\s*(?:=>|->|to|into)\s*${BRANCH}\b`, // "Main to Release", "Release => Main v77.10"
    String.raw`^(?:release(?:\s+${VERSION})?|${VERSION})$`, // "release", "Release v2.25.1", "Release 77", "v77", "v77.9", "2.25.1"
    String.raw`^merge (?:pull request|branch)\b`, // GitHub's default title for a merge commit
  ].join("|"),
  "i",
);

export function isHousekeepingPullRequest(title: string): boolean {
  return HOUSEKEEPING_TITLE.test(title.trim());
}
