import type { Metric, MetricFactory } from "../../core/metric.js";
import { collectCycleTime } from "./collect.js";
import { COLUMNS } from "./transform.js";

export const cycleTime: MetricFactory = ({ config, github, jira, repos }): Metric => ({
  name: "cycle-time",
  description: "One row per Jira issue delivered to production: first In Progress to the GitHub release containing its last pull request",
  columns: COLUMNS,
  collect: async (context) =>
    collectCycleTime(
      { jira, github },
      {
        projects: config.jira.projects,
        repos: await repos.list(),
        startDate: config.startDate,
        startStatuses: config.jira.startStatuses,
        excludedResolutions: config.jira.excludedResolutions,
        excludedStatuses: config.jira.excludedStatuses,
        excludedIssueTypes: config.jira.excludedIssueTypes,
      },
      context,
    ),
});
