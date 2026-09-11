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

/** A release that has actually shipped: published, and neither a draft nor a prerelease. */
export type PublishedRelease = GitHubRelease & { published_at: string };

export function isPublishedRelease(release: GitHubRelease): release is PublishedRelease {
  return !release.draft && !release.prerelease && release.published_at !== null;
}

export function toRow(repo: RepoRef, release: PublishedRelease): MetricRow {
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
