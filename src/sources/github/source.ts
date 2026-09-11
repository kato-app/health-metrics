import { z } from "zod";

/**
 * The subset of a GitHub release the application relies on. Validated at the
 * boundary so an API change fails loudly instead of producing bad rows.
 */
export const releaseSchema = z.object({
  id: z.number().int(),
  tag_name: z.string(),
  name: z.string().nullable(),
  target_commitish: z.string(),
  html_url: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  /** Date of the commit the release points at, NOT when it was drafted or published. */
  created_at: z.iso.datetime(),
  /** Null while the release is a draft. Set once, when published. */
  published_at: z.iso.datetime().nullable(),
  author: z.object({ login: z.string() }).nullable(),
  /** Release notes as markdown. GitHub's generated notes list one merged pull request per line. */
  body: z.string().nullish(),
});

export type GitHubRelease = z.infer<typeof releaseSchema>;

/** The subset of a pull request the application relies on. */
export const pullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.string(),
  merged_at: z.iso.datetime().nullable(),
  head: z.object({ ref: z.string() }),
});

export type GitHubPullRequest = z.infer<typeof pullRequestSchema>;

/** A repository as `owner/name`. */
export interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

export function repoFullName(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

/** A pull request located by repository and number, as used in index keys and log lines. */
export interface PullRequestRef {
  readonly repo: RepoRef;
  readonly number: number;
}

export function pullRequestKey(ref: PullRequestRef): string {
  return `${repoFullName(ref.repo)}#${ref.number}`;
}

/** Parses `https://github.com/{owner}/{repo}/pull/{n}`; undefined for anything else. */
export function parsePullRequestUrl(url: string): PullRequestRef | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(url);
  return match ? { repo: { owner: match[1]!, name: match[2]! }, number: Number(match[3]) } : undefined;
}

/**
 * Read-only access to GitHub. Release listing pages lazily so consumers can
 * stop early once they reach data they already have; repository discovery
 * scans the whole organisation and returns the complete list.
 */
export interface GitHubSource {
  /** Releases for a repository in the order GitHub returns them: newest `created_at` first. */
  listReleases(repo: RepoRef): AsyncIterable<GitHubRelease>;
  /** Names of every repository in the organisation that has at least one release of any kind. */
  listReposWithReleases(org: string): Promise<string[]>;
  /** One pull request by number. Requires the token to have "Pull requests: read" on the repository. */
  getPullRequest(ref: PullRequestRef): Promise<GitHubPullRequest>;
}
