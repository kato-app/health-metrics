import { repoFullName, type RepoRef } from "../../sources/github/source.js";
import type { ReleaseRef } from "../cycle-time/release-index.js";

/** `owner/name@tag`: unique per release, used as the map key everywhere in this metric. */
export function releaseKey(release: ReleaseRef): string {
  return `${repoFullName(release.repo)}@${release.tag}`;
}

/** Releases per repository in publication order, with the lookups attribution needs. */
export class ReleaseTimeline {
  private readonly byRepo: Map<string, ReleaseRef[]>;

  constructor(releases: readonly ReleaseRef[]) {
    this.byRepo = Map.groupBy(releases, (release) => repoFullName(release.repo));
    for (const list of this.byRepo.values()) list.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  }

  /** Oldest first. */
  releasesOf(repo: RepoRef): readonly ReleaseRef[] {
    return this.byRepo.get(repoFullName(repo)) ?? [];
  }

  /** The release of `repo` that was live at `at`: the latest published at or before it. */
  liveAt(repo: RepoRef, at: Date): ReleaseRef | undefined {
    return this.latest(repo, (release) => release.publishedAt <= at);
  }

  /** The release of the same repository published immediately before `release`. */
  previous(release: ReleaseRef): ReleaseRef | undefined {
    return this.latest(release.repo, (candidate) => candidate.publishedAt < release.publishedAt);
  }

  /** The last release of `repo`, in publication order, for which `earlyEnough` still holds. */
  private latest(repo: RepoRef, earlyEnough: (release: ReleaseRef) => boolean): ReleaseRef | undefined {
    let latest: ReleaseRef | undefined;
    for (const release of this.releasesOf(repo)) {
      if (!earlyEnough(release)) break;
      latest = release;
    }
    return latest;
  }
}
