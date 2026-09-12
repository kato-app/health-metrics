import type { CollectContext, MetricRow } from "../../core/metric.js";
import { MS_PER_DAY, newestSheetDate, startOfUtcDay } from "../../core/sheet-date.js";
import { repoFullName, type GitHubSource, type RepoRef } from "../../sources/github/source.js";
import { toRow } from "./transform.js";

/**
 * How far behind the newest published date in the sheet we keep paging.
 *
 * GitHub lists releases by `created_at` (the commit date), but we watermark on
 * `published_at`. A draft created before the watermark and published after it
 * would be skipped if paging stopped exactly at the watermark. Paging this far
 * past it, with ids de-duplicated against the sheet, closes that gap for any
 * draft published within the window.
 */
export const DEFAULT_GRACE_DAYS = 30;

export interface CollectOptions {
  readonly repos: readonly RepoRef[];
  /** `YYYY-MM-DD`; releases published before this UTC day are ignored. */
  readonly startDate: string;
  readonly graceDays?: number;
}

/** Newest `published_at` already in the sheet, or undefined when none of the rows carries one. */
export function findWatermark(existingRows: readonly MetricRow[]): Date | undefined {
  return newestSheetDate(existingRows, "published_at");
}

/** Oldest first. `published_at` is a fixed-width UTC string, so plain comparison orders it chronologically. */
function byPublishedThenId(a: MetricRow, b: MetricRow): number {
  if (a.published_at !== b.published_at) return String(a.published_at) < String(b.published_at) ? -1 : 1;
  return Number(a.id) - Number(b.id);
}

export async function collectDeploymentFrequency(
  source: GitHubSource,
  options: CollectOptions,
  context: CollectContext,
): Promise<MetricRow[]> {
  const { logger, existingRows } = context;
  const startDate = startOfUtcDay(options.startDate);
  const watermark = findWatermark(existingRows);
  if (!watermark && existingRows.length > 0) {
    logger.warn("Existing rows have no readable published_at; backfilling from the start date", {
      existingRows: existingRows.length,
    });
  }
  const graceMs = (options.graceDays ?? DEFAULT_GRACE_DAYS) * MS_PER_DAY;
  const pagingCutoff = watermark ? new Date(Math.max(startDate.getTime(), watermark.getTime() - graceMs)) : startDate;
  // Sheets may hand ids back as numbers or strings; compare as strings.
  const knownIds = new Set(existingRows.map((row) => String(row.id)));

  logger.debug("Collecting releases", {
    startDate: startDate.toISOString(),
    watermark: watermark?.toISOString() ?? null,
    pagingCutoff: pagingCutoff.toISOString(),
    knownIds: knownIds.size,
  });

  const rows: MetricRow[] = [];
  for (const repo of options.repos) {
    const repoLogger = logger.child({ repo: repoFullName(repo) });
    let seen = 0;
    let added = 0;

    for await (const release of source.listReleases(repo)) {
      seen += 1;
      // Listing is newest-created first, so everything after this is older than we care about.
      if (new Date(release.created_at) < pagingCutoff) break;

      if (release.draft || release.prerelease || release.published_at === null) {
        repoLogger.debug("Skipping unpublished release", { id: release.id, tag: release.tag_name });
        continue;
      }
      if (new Date(release.published_at) < startDate) continue;
      if (knownIds.has(String(release.id))) continue;

      rows.push(toRow(repo, release));
      knownIds.add(String(release.id));
      added += 1;
    }

    repoLogger.info("Collected releases", { seen, added });
  }

  return rows.sort(byPublishedThenId);
}
