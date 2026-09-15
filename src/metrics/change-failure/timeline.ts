import { repoFullName, type RepoRef } from "../../sources/github/source.js";
import type { ReleaseRef } from "../cycle-time/release-index.js";

/** `owner/name@tag`: unique per release, used as the map key everywhere in this metric. */
export function releaseKey(release: ReleaseRef): string {
  return `${repoFullName(release.repo)}@${release.tag}`;
}

/** Releases per repository in publication order, with the lookups attribution needs. */
export class ReleaseTimeline {
  private readonly byRepo = new Map<string, ReleaseRef[]>();

  constructor(releases: readonly ReleaseRef[]) {
    for (const release of releases) {
      const key = repoFullName(release.repo);
      (this.byRepo.get(key) ?? this.byRepo.set(key, []).get(key)!).push(release);
    }
    for (const list of this.byRepo.values()) list.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  }

  /** Oldest first. */
  releasesOf(repo: RepoRef): readonly ReleaseRef[] {
    return this.byRepo.get(repoFullName(repo)) ?? [];
  }

  /** The release of `repo` that was live at `at`: the latest published at or before it. */
  liveAt(repo: RepoRef, at: Date): ReleaseRef | undefined {
    let live: ReleaseRef | undefined;
    for (const release of this.releasesOf(repo)) {
      if (release.publishedAt > at) break;
      live = release;
    }
    return live;
  }

  /** The release of the same repository published immediately before `release`. */
  previous(release: ReleaseRef): ReleaseRef | undefined {
    let previous: ReleaseRef | undefined;
    for (const candidate of this.releasesOf(release.repo)) {
      if (candidate.publishedAt >= release.publishedAt) break;
      previous = candidate;
    }
    return previous;
  }
}
