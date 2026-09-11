import type { MetricRow } from "../../core/metric.js";
import { formatSheetDate } from "../../core/sheet-date.js";
import { repoFullName, type GitHubRelease, type RepoRef } from "../../sources/github/source.js";

export const COLUMNS = [
  "published_at",
  "repo",
  "id",
  "author_login",
  "tag_name",
  "name",
  "target_commitish",
  "html_url",
] as const;

/** Maps a published release to a sheet row. Throws on a release that has no `published_at`. */
export function toRow(repo: RepoRef, release: GitHubRelease): MetricRow {
  if (release.published_at === null) {
    throw new Error(`Release ${release.id} (${release.tag_name}) has not been published`);
  }
  return {
    published_at: formatSheetDate(release.published_at),
    repo: repoFullName(repo),
    id: release.id,
    author_login: release.author?.login ?? null,
    tag_name: release.tag_name,
    name: release.name,
    target_commitish: release.target_commitish,
    html_url: release.html_url,
  };
}
