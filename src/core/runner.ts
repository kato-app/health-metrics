import { errorContext, type Logger } from "../logging/logger.js";
import { assertRowShape, type Metric } from "./metric.js";
import type { MetricSink } from "./sink.js";

export interface RunOptions {
  readonly sink: MetricSink;
  readonly logger: Logger;
  /** Collect and log rows, but do not write them to the sink. */
  readonly dryRun: boolean;
}

export type MetricRunResult =
  | {
      readonly metric: string;
      readonly status: "ok";
      /** New rows the metric produced. */
      readonly rowsCollected: number;
      /** Rows actually appended to the sink; zero in a dry run. */
      readonly rowsWritten: number;
    }
  | { readonly metric: string; readonly status: "failed"; readonly error: unknown };

/**
 * Runs a single metric end to end: read existing rows, collect the delta,
 * validate it, append it. Never throws; failures are returned so callers can
 * decide how to aggregate them.
 */
export async function runMetric(metric: Metric, options: RunOptions): Promise<MetricRunResult> {
  const logger = options.logger.child({ metric: metric.name });
  try {
    logger.info("Starting metric run", { dryRun: options.dryRun });

    const existingRows = await options.sink.readRows(metric);
    logger.debug("Read existing rows", { count: existingRows.length });

    const rows = await metric.collect({ existingRows, logger });
    for (const row of rows) assertRowShape(metric, row);

    const ok = (rowsWritten: number): MetricRunResult => ({
      metric: metric.name,
      status: "ok",
      rowsCollected: rows.length,
      rowsWritten,
    });

    if (rows.length === 0) {
      logger.info("No new rows");
      return ok(0);
    }

    if (options.dryRun) {
      for (const row of rows) logger.info("Would write row", { row });
      logger.info("Dry run complete; nothing written", { rows: rows.length });
      return ok(0);
    }

    await options.sink.appendRows(metric, rows);
    logger.info("Wrote rows", { rows: rows.length });
    return ok(rows.length);
  } catch (error) {
    logger.error("Metric run failed", errorContext(error));
    return { metric: metric.name, status: "failed", error };
  }
}

/** Runs metrics one after another so a failure in one never affects the others. */
export async function runMetrics(metrics: readonly Metric[], options: RunOptions): Promise<MetricRunResult[]> {
  const results: MetricRunResult[] = [];
  for (const metric of metrics) results.push(await runMetric(metric, options));
  return results;
}
