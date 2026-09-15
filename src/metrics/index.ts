import type { Metric, MetricDependencies, MetricFactory } from "../core/metric.js";
import { changeFailure, unclaimedHotfixes } from "./change-failure/index.js";
import { cycleTime } from "./cycle-time/index.js";
import { deploymentFrequency } from "./deployment-frequency/index.js";
import { unlinkedPrs } from "./unlinked-prs/index.js";

/**
 * Every metric the CLI knows about. Register new metrics here; the CLI's
 * `list` and `run` commands are driven entirely from this array.
 */
const factories: readonly MetricFactory[] = [deploymentFrequency, cycleTime, unlinkedPrs, changeFailure, unclaimedHotfixes];

export function createMetrics(deps: MetricDependencies): Metric[] {
  const metrics = factories.map((factory) => factory(deps));
  const names = new Set<string>();
  for (const metric of metrics) {
    if (names.has(metric.name)) throw new Error(`Duplicate metric name: ${metric.name}`);
    names.add(metric.name);
  }
  return metrics;
}
