import type { Metric, MetricFactory } from "../../core/metric.js";
import { collectDeploymentFrequency } from "./collect.js";
import { COLUMNS } from "./transform.js";

export const deploymentFrequency: MetricFactory = ({ config, github, repos }): Metric => ({
  name: "deployment-frequency",
  description:
    "One row per published GitHub release (drafts and prereleases excluded) across every organisation repo with releases",
  columns: COLUMNS,
  collect: async (context) =>
    collectDeploymentFrequency(github, { repos: await repos.list(), startDate: config.startDate }, context),
});
