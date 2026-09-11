import type { CollectContext, MetricRow } from "../../core/metric.js";
import { parseSheetDate, startOfUtcDay } from "../../core/sheet-date.js";
import { repoFullName, type GitHubSource, type RepoRef } from "../../sources/github/source.js";
import { isPublishedRelease, toRow } from "./transform.js";

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

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CollectOptions {
  readonly repos: readonly RepoRef[];
  /** `YYYY-MM-DD`; releases published before this UTC day are ignored. */
  readonly startDate: string;
  readonly graceDays?: number;
}

/** Newest `published_at` already in the sheet, or undefined when the sheet is empty. */
export function findWatermark(existingRows: readonly MetricRow[]): Date | undefined {
  let newest: Date | undefined;
  for (const row of existingRows) {
    const date = parseSheetDate(row.published_at);
    if (date && (!newest || date > newest)) newest = date;
  }
  return newest;
}

function byPublishedThenId(a: MetricRow, b: MetricRow): number {
  const byDate = String(a.published_at).localeCompare(String(b.published_at));
  return byDate !== 0 ? byDate : Number(a.id) - Number(b.id);
}

export async function collectDeploymentFrequency(
  source: GitHubSource,
  options: CollectOptions,
  context: CollectContext,
): Promise<MetricRow[]> {
  const { logger, existingRows } = context;
  const startDate = startOfUtcDay(options.startDate);
  const watermark = findWatermark(existingRows);
  const graceMs = (options.graceDays ?? DEFAULT_GRACE_DAYS) * DAY_MS;
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

      if (!isPublishedRelease(release)) {
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
