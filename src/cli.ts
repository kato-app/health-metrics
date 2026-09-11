import { Command } from "commander";
import { ConfigError, fromProjectRoot, loadConfig, loadEnv, resolveKeyFile } from "./config/load.js";
import type { Config, Env } from "./config/schema.js";
import type { Metric } from "./core/metric.js";
import { runMetrics } from "./core/runner.js";
import type { MetricSink } from "./core/sink.js";
import { createLogger } from "./logging/create-logger.js";
import { errorContext, type Logger } from "./logging/logger.js";
import { createMetrics } from "./metrics/index.js";
import { createGoogleSheetsClient } from "./sinks/google-sheets/google-client.js";
import { createSheetsSink } from "./sinks/google-sheets/sheets-sink.js";
import { createOctokitSource } from "./sources/github/octokit-source.js";
import type { GitHubSource } from "./sources/github/source.js";

/** For commands that only describe metrics and must never reach the network. */
const offlineGitHub: GitHubSource = {
  listReleases() {
    throw new Error("GitHub is not available in this command");
  },
};

interface RunCommandOptions {
  all?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
}

/** The user asked for something the CLI cannot do. Reported without a stack trace. */
class UsageError extends Error {
  override name = "UsageError";
}

function selectMetrics(available: Metric[], name: string | undefined, all: boolean | undefined): Metric[] {
  if (all && name) throw new UsageError("Pass either a metric name or --all, not both");
  if (all) return available;
  if (!name) throw new UsageError("Pass a metric name or --all");
  const metric = available.find((m) => m.name === name);
  if (!metric) {
    throw new UsageError(
      `Unknown metric "${name}". Available: ${available.map((m) => m.name).join(", ") || "(none)"}`,
    );
  }
  return [metric];
}

function isExpectedError(error: unknown): error is Error {
  return error instanceof UsageError || error instanceof ConfigError;
}

function createSink(config: Config, env: Env, logger: Logger): MetricSink {
  const client = createGoogleSheetsClient({ spreadsheetId: config.spreadsheetId, keyFile: resolveKeyFile(env) });
  return createSheetsSink(client, logger);
}

async function runCommand(name: string | undefined, opts: RunCommandOptions): Promise<number> {
  const config = loadConfig();
  const logger = createLogger({
    file: fromProjectRoot(config.logging.file),
    consoleLevel: opts.verbose ? "debug" : "info",
  });

  try {
    const env = loadEnv();
    const github = createOctokitSource({ token: env.GITHUB_TOKEN, logger });
    const metrics = selectMetrics(createMetrics({ config, logger, github }), name, opts.all);
    const sink = createSink(config, env, logger);
    const results = await runMetrics(metrics, { sink, logger, dryRun: opts.dryRun ?? false });

    const succeeded = results.filter((r) => r.status === "ok");
    logger.info("Run complete", {
      metrics: results.length,
      failed: results.length - succeeded.length,
      rowsCollected: succeeded.reduce((n, r) => n + r.rowsCollected, 0),
      rowsWritten: succeeded.reduce((n, r) => n + r.rowsWritten, 0),
    });
    return succeeded.length === results.length ? 0 : 1;
  } catch (error) {
    if (isExpectedError(error)) logger.error(`Run aborted: ${error.message}`);
    else logger.error("Run aborted", errorContext(error));
    return 1;
  }
}

function listCommand(): void {
  const config = loadConfig();
  const metrics = createMetrics({ config, logger: createLogger({ consoleLevel: "warn" }), github: offlineGitHub });
  if (metrics.length === 0) {
    console.log("No metrics registered.");
    return;
  }
  const width = Math.max(...metrics.map((m) => m.name.length));
  for (const m of metrics) console.log(`${m.name.padEnd(width)}  ${m.description}`);
}

const program = new Command()
  .name("metrics")
  .description("Collects engineering health metrics and writes them to Google Sheets")
  .showHelpAfterError();

program
  .command("run")
  .description("Collect a metric (or all metrics) and write new rows to the sheet")
  .argument("[name]", "metric name, as shown by `metrics list`")
  .option("-a, --all", "run every registered metric")
  .option("-n, --dry-run", "collect and log rows without writing to the sheet")
  .option("-v, --verbose", "print debug-level logs to the console")
  .action(async (name: string | undefined, opts: RunCommandOptions) => {
    process.exitCode = await runCommand(name, opts);
  });

program.command("list").description("List registered metrics").action(listCommand);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
}
