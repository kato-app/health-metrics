import type { Metric, MetricFactory } from "../../core/metric.js";
import { collectDeploymentFrequency } from "./collect.js";
import { COLUMNS } from "./transform.js";

export const deploymentFrequency: MetricFactory = ({ config, github }): Metric => ({
  name: "deployment-frequency",
  description: "One row per published GitHub release (drafts and prereleases excluded) across the configured repos",
  columns: COLUMNS,
  collect: (context) =>
    collectDeploymentFrequency(
      github,
      {
        repos: config.github.repos.map((name) => ({ owner: config.github.owner, name })),
        startDate: config.startDate,
      },
      context,
    ),
});
