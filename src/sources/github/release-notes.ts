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
const ARROW = String.raw`(?:=>|->|<-+|to|into)`;
/** "v77.9", "v 73.31": a version that is unmistakably a tag. */
const TAGGED_VERSION = String.raw`v\s?\d+(?:\.\d+)*`;
/** A tag or a bare number such as "77" or "2.25.1". Only trusted when it is (almost) the whole title. */
const VERSION = String.raw`(?:${TAGGED_VERSION}|\d+(?:\.\d+)*)`;
/** A single word such as a repository name: "kato", "kato-settings". */
const WORD = String.raw`[a-z][\w-]*`;

/**
 * Titles of pull requests that exist to move code between long-lived branches
 * or cut a version, which never carry an issue key and are not worth flagging
 * as unlinked. Version titles must be the whole title so that feature work
 * such as "V2 endpoints" is still flagged, and a word followed by a version is
 * only a version cut when the version carries its "v" ("kato v76.3"), so that
 * "Node 22" or "Phase 2 release" are still flagged.
 */
const HOUSEKEEPING_TITLE = new RegExp(
  [
    // Branch syncs: "Main to Release", "Release => Main v77.10", "Release <-- Main", "Merging Main to Release due to Hotfix"
    String.raw`^(?:merging\s+)?${BRANCH}\s*${ARROW}\s*${BRANCH}\b`,
    // Branch refreshes: "Update release branch with main"
    String.raw`^update ${BRANCH} branch (?:with|from) ${BRANCH}\b`,
    // Version cuts: "release", "Release v2.25.1", "Release for v70.7", "Release v4.3 to main", "Release for v70 (Confidentiality)", "v77.9", "2.25.1", "v73.15 Release"
    String.raw`^(?:release(?:\s+(?:for\s+)?${VERSION})?|${VERSION}(?:\s+release)?)(?:\s+to\s+${BRANCH})?(?:\s*\(.*\))?$`,
    // Repository name plus tag: "kato v76.3", "kato v76.3 release"
    String.raw`^${WORD}\s+${TAGGED_VERSION}(?:\s+release)?$`,
    // GitHub's default title for a merge commit
    String.raw`^merge (?:pull request|branch)\b`,
  ].join("|"),
  "i",
);

export function isHousekeepingPullRequest(title: string): boolean {
  return HOUSEKEEPING_TITLE.test(title.trim());
}
