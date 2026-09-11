import type { Config } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import type { RepoRegistry } from "../sources/github/repo-registry.js";
import type { GitHubSource } from "../sources/github/source.js";

/** A value that can be written to a single spreadsheet cell. */
export type CellValue = string | number | boolean | null;

/** One output row, keyed by column name. Every metric column must be present. */
export type MetricRow = Readonly<Record<string, CellValue>>;

export interface CollectContext {
  /**
   * Rows already present in the metric's sheet, oldest first. Metrics use this
   * to derive their watermark and to avoid re-emitting rows they have already
   * written. Empty on a first run, which means a full backfill.
   */
  readonly existingRows: readonly MetricRow[];
  readonly logger: Logger;
}

/**
 * A metric knows where its data comes from and how to turn it into rows.
 * It is deliberately unaware of Google Sheets: the runner reads existing rows
 * from the sink, hands them to `collect`, and appends whatever comes back.
 *
 * `name` doubles as the sheet tab name.
 */
export interface Metric {
  readonly name: string;
  readonly description: string;
  /** Ordered column headers. Rows returned by `collect` must use exactly these keys. */
  readonly columns: readonly string[];
  /** Returns only rows that are not yet in the sink, ordered oldest first. */
  collect(context: CollectContext): Promise<MetricRow[]>;
}

/** Everything a metric factory may need. Extend as new sources are added. */
export interface MetricDependencies {
  readonly config: Config;
  readonly logger: Logger;
  readonly github: GitHubSource;
  /** Repositories to collect from, discovered once per run. Ask at collect time, not construction time. */
  readonly repos: RepoRegistry;
}

export type MetricFactory = (deps: MetricDependencies) => Metric;

/** Asserts that a row carries exactly the metric's columns and nothing else. */
export function assertRowShape(metric: Metric, row: MetricRow): void {
  const actual = new Set(Object.keys(row));
  const missing = metric.columns.filter((c) => !actual.has(c));
  const extra = [...actual].filter((c) => !metric.columns.includes(c));
  if (missing.length || extra.length) {
    throw new Error(
      `Metric "${metric.name}" produced a row with the wrong shape` +
        (missing.length ? `; missing: ${missing.join(", ")}` : "") +
        (extra.length ? `; unexpected: ${extra.join(", ")}` : ""),
    );
  }
}
