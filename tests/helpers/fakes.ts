import type { CollectContext, Metric, MetricRow } from "../../src/core/metric.js";
import type { MetricSink } from "../../src/core/sink.js";

/** In-memory sink that records what was read and appended. */
export class InMemorySink implements MetricSink {
  readonly tabs = new Map<string, MetricRow[]>();
  readonly appendCalls: { metric: string; rows: readonly MetricRow[] }[] = [];

  seed(metricName: string, rows: MetricRow[]): void {
    this.tabs.set(metricName, [...rows]);
  }

  async readRows(metric: Metric): Promise<MetricRow[]> {
    return [...(this.tabs.get(metric.name) ?? [])];
  }

  async appendRows(metric: Metric, rows: readonly MetricRow[]): Promise<void> {
    this.appendCalls.push({ metric: metric.name, rows });
    this.tabs.set(metric.name, [...(this.tabs.get(metric.name) ?? []), ...rows]);
  }
}

/** Builds a metric whose `collect` is supplied by the test. */
export function fakeMetric(
  name: string,
  columns: readonly string[],
  collect: (ctx: CollectContext) => Promise<MetricRow[]>,
): Metric {
  return { name, description: `fake ${name}`, columns, collect };
}
