import type { Metric, MetricRow } from "./metric.js";

/**
 * Destination for metric rows: storage per metric that can be read back (so
 * append metrics can find their watermark), appended to, or replaced wholesale
 * (for snapshot metrics).
 */
export interface MetricSink {
  /** All rows currently stored for the metric, oldest first. Empty if the metric has never been written. */
  readRows(metric: Metric): Promise<MetricRow[]>;
  /** Appends rows in the given order, creating storage for the metric if needed. */
  appendRows(metric: Metric, rows: readonly MetricRow[]): Promise<void>;
  /** Discards every stored row for the metric and stores `rows` instead. An empty list leaves the header only. */
  replaceRows(metric: Metric, rows: readonly MetricRow[]): Promise<void>;
}
