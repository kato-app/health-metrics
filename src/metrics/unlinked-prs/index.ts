import type { Metric, MetricFactory } from "../../core/metric.js";
import { COLUMNS, collectUnlinkedPullRequests } from "./collect.js";

export const unlinkedPrs: MetricFactory = ({ config, github, jira, repos }): Metric => ({
  name: "unlinked-prs",
  description: "Snapshot of shipped pull requests that cycle time cannot attribute to a Jira issue; empties as titles are fixed",
  columns: COLUMNS,
  mode: "snapshot",
  collect: async (context) =>
    collectUnlinkedPullRequests(
      { jira, github },
      { projects: config.jira.projects, repos: await repos.list(), startDate: config.startDate },
      context,
    ),
});
