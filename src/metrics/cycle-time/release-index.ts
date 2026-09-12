import type { Logger } from "../../logging/logger.js";
import { parseReleaseNotes } from "../../sources/github/release-notes.js";
import { pullRequestKey, repoFullName, type GitHubSource, type PullRequestRef, type RepoRef } from "../../sources/github/source.js";

/** A published release that shipped some pull requests. */
export interface ReleaseRef {
  readonly repo: RepoRef;
  readonly tag: string;
  readonly publishedAt: Date;
}

/** A pull request as listed in a release's notes, with the release it shipped in. */
export interface ShippedPullRequest {
  readonly ref: PullRequestRef;
  readonly title: string;
  readonly release: ReleaseRef;
}

export interface ReleaseIndex {
  /** The earliest published release whose notes list the pull request, if any. */
  releaseFor(ref: PullRequestRef): ReleaseRef | undefined;
  /** Every pull request listed in the indexed releases' notes, for linkage auditing. */
  readonly shipped: readonly ShippedPullRequest[];
}

/**
 * Reads every published release since `since` across `repos` and maps each
 * pull request mentioned in the release notes to the release that shipped it.
 * Drafts and prereleases are ignored, matching the deployment-frequency rules.
 * A pull request listed by more than one release is attributed to the earliest.
 *
 * Paging stops at the first release created before `since`. As with
 * deployment-frequency, a release cut from an older commit but published after
 * `since` is therefore not indexed; pass an earlier `since` to widen the window.
 */
export async function buildReleaseIndex(
  github: GitHubSource,
  repos: readonly RepoRef[],
  since: Date,
  logger: Logger,
): Promise<ReleaseIndex> {
  const byPullRequest = new Map<string, ShippedPullRequest>();
  let releases = 0;

  for (const repo of repos) {
    for await (const release of github.listReleases(repo)) {
      // Listing is newest-created first; nothing older is of interest.
      if (new Date(release.created_at) < since) break;
      if (release.draft || release.prerelease || release.published_at === null) continue;
      const publishedAt = new Date(release.published_at);
      if (publishedAt < since) continue;
      releases += 1;

      const releaseRef: ReleaseRef = { repo, tag: release.tag_name, publishedAt };
      for (const { ref, title } of parseReleaseNotes(release.body)) {
        const key = pullRequestKey(ref);
        const existing = byPullRequest.get(key);
        if (!existing || publishedAt < existing.release.publishedAt) byPullRequest.set(key, { ref, title, release: releaseRef });
      }
    }
    logger.debug("Indexed releases", { repo: repoFullName(repo) });
  }

  logger.info("Built release index", { repos: repos.length, releases, pullRequests: byPullRequest.size, since: since.toISOString() });
  return {
    releaseFor: (ref) => byPullRequest.get(pullRequestKey(ref))?.release,
    shipped: [...byPullRequest.values()],
  };
}
