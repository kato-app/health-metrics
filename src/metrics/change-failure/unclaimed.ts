import { compareRows, type CollectContext, type MetricRow } from "../../core/metric.js";
import { formatSheetDate } from "../../core/sheet-date.js";
import { repoFullName } from "../../sources/github/source.js";
import type { UnclaimedRemediation } from "./remediations.js";
import { buildRemediationReport, type ChangeFailureOptions, type ChangeFailureSources } from "./report.js";

export const COLUMNS = ["released_at", "repo", "tag", "signal", "evidence", "author", "reason"] as const;

export function toRow(unclaimed: UnclaimedRemediation): MetricRow {
  return {
    released_at: formatSheetDate(unclaimed.release.publishedAt),
    repo: repoFullName(unclaimed.release.repo),
    tag: unclaimed.release.tag,
    signal: unclaimed.signal,
    evidence: unclaimed.evidence,
    author: unclaimed.author,
    reason: unclaimed.reason,
  };
}

/**
 * Snapshot of every hotfix, revert or patch release since `startDate` that
 * change-failure could not pin on an earlier release, with the reason. Fixing
 * the cause (usually adding the issue key to the pull request title) removes
 * the row on the next run. `--full` changes nothing here.
 */
export async function collectUnclaimedHotfixes(sources: ChangeFailureSources, options: ChangeFailureOptions, context: CollectContext): Promise<MetricRow[]> {
  const { report } = await buildRemediationReport(sources, options, context.logger);
  return report.unclaimed.map(toRow).sort(compareRows("released_at", "repo", "tag", "evidence"));
}
