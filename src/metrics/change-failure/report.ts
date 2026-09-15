import type { JiraProject } from "../../config/schema.js";
import { startOfUtcDay } from "../../core/sheet-date.js";
import type { Logger } from "../../logging/logger.js";
import type { GitHubSource, RepoRef } from "../../sources/github/source.js";
import type { JiraSource } from "../../sources/jira/source.js";
import { buildReleaseIndex, type ReleaseIndex } from "../cycle-time/release-index.js";
import { findRemediations, type RemediationReport } from "./remediations.js";

export interface ChangeFailureSources {
  readonly jira: JiraSource;
  readonly github: GitHubSource;
}

/** Settings shared by the change-failure and unclaimed-hotfixes metrics. */
export interface ChangeFailureOptions {
  readonly projects: readonly JiraProject[];
  readonly repos: readonly RepoRef[];
  /** `YYYY-MM-DD`; releases published before this UTC day are neither judged nor blamed. */
  readonly startDate: string;
  readonly settlingDays: number;
  readonly keylessAttributionDays: number;
  readonly regressionLabel: string;
}

/** The release index since `options.startDate` and every remediation attributed within it. */
export async function buildRemediationReport(
  sources: ChangeFailureSources,
  options: ChangeFailureOptions,
  logger: Logger,
): Promise<{ index: ReleaseIndex; report: RemediationReport }> {
  const startDate = startOfUtcDay(options.startDate);
  const index = await buildReleaseIndex(sources.github, options.repos, startDate, logger);
  const report = await findRemediations(
    index,
    sources.jira,
    options.repos,
    {
      projectKeys: options.projects.map((p) => p.key),
      startDate,
      keylessAttributionDays: options.keylessAttributionDays,
      regressionLabel: options.regressionLabel,
    },
    logger,
  );
  return { index, report };
}
