import type { Metric, MetricDependencies, MetricFactory } from "../../core/metric.js";
import { COLUMNS as CHANGE_FAILURE_COLUMNS, collectChangeFailure } from "./collect.js";
import type { ChangeFailureOptions } from "./report.js";
import { COLUMNS as UNCLAIMED_COLUMNS, collectUnclaimedHotfixes } from "./unclaimed.js";

/** Both metrics read the same sources (`deps` itself) with the same settings, so they always agree. */
async function optionsFrom({ config, repos }: MetricDependencies): Promise<ChangeFailureOptions> {
  return {
    projects: config.jira.projects,
    repos: await repos.list(),
    startDate: config.startDate,
    settlingDays: config.changeFailure.settlingDays,
    keylessAttributionDays: config.changeFailure.keylessAttributionDays,
    regressionLabel: config.changeFailure.regressionLabel,
  };
}

export const changeFailure: MetricFactory = (deps): Metric => ({
  name: "change-failure",
  description: "One row per published release, judged after a settling window: did it need a hotfix, revert, patch or regression fix, and how do we know",
  columns: CHANGE_FAILURE_COLUMNS,
  collect: async (context) => collectChangeFailure(deps, await optionsFrom(deps), context),
});

export const unclaimedHotfixes: MetricFactory = (deps): Metric => ({
  name: "unclaimed-hotfixes",
  description: "Snapshot of hotfixes, reverts and patch releases that change-failure could not pin on an earlier release; empties as titles gain issue keys",
  columns: UNCLAIMED_COLUMNS,
  mode: "snapshot",
  collect: async (context) => collectUnclaimedHotfixes(deps, await optionsFrom(deps), context),
});
