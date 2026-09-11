import type { Metric, MetricRow } from "./metric.js";

/**
 * Destination for metric rows. The runner treats it as append-only storage
 * that can also be read back so metrics can find their watermark.
 */
export interface MetricSink {
  /** All rows currently stored for the metric, oldest first. Empty if the metric has never been written. */
  readRows(metric: Metric): Promise<MetricRow[]>;
  /** Appends rows in the given order, creating storage for the metric if needed. */
  appendRows(metric: Metric, rows: readonly MetricRow[]): Promise<void>;
}
