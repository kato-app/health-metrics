import { compareRows, type CollectContext, type MetricRow } from "../../core/metric.js";
import { MS_PER_DAY, formatSheetDate, newestSheetDate, startOfUtcDay } from "../../core/sheet-date.js";
import { repoFullName } from "../../sources/github/source.js";
import type { ReleaseRef } from "../cycle-time/release-index.js";
import { calendarDays } from "../cycle-time/transform.js";
import type { Remediation, RemediationSignal } from "./remediations.js";
import { buildRemediationReport, type ChangeFailureOptions, type ChangeFailureSources } from "./report.js";
import { releaseKey } from "./timeline.js";

export const COLUMNS = [
  "released_at",
  "repo",
  "tag",
  "failed",
  "hotfix",
  "revert",
  "patch_tag",
  "jira_regression",
  "remediated_by",
  "first_remediation_at",
  "days_to_remediation",
] as const;

const SIGNALS: readonly RemediationSignal[] = ["hotfix", "revert", "patch_tag", "jira_regression"];

/**
 * How far behind the newest `released_at` in the sheet we re-examine releases.
 * A skipped run needs no grace, since the watermark does not move until rows
 * are written; the window covers a release that entered the index late, such
 * as a prerelease promoted to a full release after the fact. `--full` covers
 * anything older.
 */
export const DEFAULT_GRACE_DAYS = 30;

export interface CollectOptions extends ChangeFailureOptions {
  readonly graceDays?: number;
  /** Injected in tests. Defaults to the wall clock. */
  readonly now?: Date;
}

export function toRow(release: ReleaseRef, remediations: readonly Remediation[]): MetricRow {
  const evidence = (signal: RemediationSignal) => remediations.filter((r) => r.signal === signal).map((r) => r.evidence).join("; ") || null;
  const first = remediations.map((r) => r.at).sort((a, b) => a.getTime() - b.getTime())[0];
  const remediatedBy = new Set(remediations.map((r) => r.remediatedBy?.tag).filter((tag) => tag !== undefined));
  return {
    released_at: formatSheetDate(release.publishedAt),
    repo: repoFullName(release.repo),
    tag: release.tag,
    failed: remediations.length > 0,
    hotfix: evidence("hotfix"),
    revert: evidence("revert"),
    patch_tag: evidence("patch_tag"),
    jira_regression: evidence("jira_regression"),
    remediated_by: [...remediatedBy].join(", ") || null,
    first_remediation_at: first ? formatSheetDate(first) : null,
    days_to_remediation: first ? calendarDays(release.publishedAt, first) : null,
  };
}

/**
 * One row per published release (draft and prerelease excluded) in every
 * collected repository, written once the settling window has passed, saying
 * whether the release needed remediation and how we know. Change failure rate
 * is `failed` rows over all rows, computed in the sheet.
 */
export async function collectChangeFailure(sources: ChangeFailureSources, options: CollectOptions, context: CollectContext): Promise<MetricRow[]> {
  const { logger, existingRows } = context;
  const startDate = startOfUtcDay(options.startDate);
  const now = options.now ?? new Date();
  const settledBefore = new Date(now.getTime() - options.settlingDays * MS_PER_DAY);

  const sheetWatermark = newestSheetDate(existingRows, "released_at");
  if (!sheetWatermark && existingRows.length > 0) {
    logger.warn("Existing rows have no readable released_at; judging every settled release since the start date", { existingRows: existingRows.length });
  }
  const watermark = context.full ? undefined : sheetWatermark;
  const graceMs = (options.graceDays ?? DEFAULT_GRACE_DAYS) * MS_PER_DAY;
  const since = watermark ? new Date(Math.max(startDate.getTime(), watermark.getTime() - graceMs)) : startDate;
  // Same shape as `releaseKey`, built from the sheet's own columns.
  const known = new Set(existingRows.map((row) => `${row.repo}@${row.tag}`));

  // Attribution needs every release since the start date, even when only the newest are written.
  const { index, report } = await buildRemediationReport(sources, options, logger);

  const rows: MetricRow[] = [];
  let unsettled = 0;
  for (const release of index.releases) {
    if (release.publishedAt > settledBefore) {
      unsettled += 1;
      continue;
    }
    if (release.publishedAt < since) continue;
    const key = releaseKey(release);
    if (known.has(key)) continue;
    rows.push(toRow(release, report.byRelease.get(key) ?? []));
  }

  logger.info("Judged releases", {
    releases: index.releases.length,
    unsettled,
    watermark: watermark?.toISOString() ?? null,
    known: known.size,
    added: rows.length,
    failed: rows.filter((r) => r.failed === true).length,
    bySignal: Object.fromEntries(SIGNALS.map((s) => [s, rows.filter((r) => r[s] !== null).length])),
  });
  return rows.sort(compareRows("released_at", "repo", "tag"));
}
