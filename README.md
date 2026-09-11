# HealthMetrics

A small Node.js/TypeScript CLI that collects engineering health metrics from their source systems and appends them to a Google Sheet, one tab per metric. Each run collects only the delta since the last run.

## Setup

Requirements: Node 26+ and npm.

```sh
npm install
cp .env.example .env   # then fill in the values
```

`.env` holds secrets and is never committed:

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Personal access token with read access to the configured repositories. |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Path to a Google service account key JSON. Share the spreadsheet with the service account's email as an Editor. |

`config.json` holds non-secret settings and is committed:

| Key | Purpose |
| --- | --- |
| `spreadsheetId` | The Google Sheet all metrics write to. |
| `startDate` | Earliest date (UTC, inclusive) backfilled when a metric's tab is empty. |
| `github.owner` | GitHub organisation or user that owns the repositories. |
| `github.repos` | Repositories to collect from. |
| `logging.file` | Project-relative path of the JSON log file, appended to on every run. |

## CLI

```sh
npm run metrics -- list                         # show registered metrics
npm run metrics -- run <name>                   # collect one metric and write new rows
npm run metrics -- run --all                    # collect every metric; each runs independently
npm run metrics -- run <name> --dry-run         # collect and log rows without writing
npm run metrics -- run --all --verbose          # debug-level console output
```

Exit code is `0` when every selected metric succeeded and `1` if any failed or the run could not start.

Other scripts:

```sh
npm test          # unit tests (Node test runner)
npm run typecheck # tsc --noEmit
npm run build     # compile to dist/
npm start -- list # run the compiled CLI (same commands as above)
```

## Logging

Console output is human-readable at `info` level (`debug` with `--verbose`). Every run also appends newline-delimited JSON at `debug` level to the file named in `config.json`, so local history survives between runs. The application talks to a `Logger` interface in `src/logging/logger.ts`; the pino implementation behind it is the only place a real transport is configured, so shipping logs elsewhere later is a change confined to that module.

## How a run works

1. Load and validate `config.json` and `.env`. Invalid or missing values abort before anything is contacted.
2. Resolve the requested metric(s) from the registry in `src/metrics/index.ts`.
3. For each metric, in turn:
   1. Read the rows already in the metric's sheet tab.
   2. Ask the metric to collect only rows newer than what is there (see each metric's rules below).
   3. Validate every row has exactly the metric's columns.
   4. Append the rows to the tab, oldest first. A metric with no new rows writes nothing.
4. A failure in one metric is logged and does not stop the others. The process exits non-zero if any failed.

## Metrics

Each metric owns one tab in the spreadsheet, named exactly after the metric. Dates are written as `YYYY-MM-DD HH:MM:SS` in UTC so Google Sheets parses them as native date-times.

_No metrics registered yet. Deployment frequency arrives in the next increment._

## Adding a metric

1. Create `src/metrics/<name>/` with a factory that returns a `Metric` (see `src/core/metric.ts`): a name, description, ordered `columns`, and a `collect` function that receives the existing rows and returns only new ones, oldest first.
2. Register the factory in `src/metrics/index.ts`.
3. Add unit tests for the transform and the delta logic against fakes of the source.
4. Document the metric's source, columns, and exclusion rules in this README.

## Project layout

```
src/
  cli.ts            command-line entry point
  config/           config.json + .env loading and validation
  core/             Metric and MetricSink contracts, the runner
  logging/          Logger interface and the pino-backed implementation
  metrics/          metric registry and one folder per metric
  sinks/            MetricSink implementations (Google Sheets)
  sources/          typed clients for source systems (GitHub)
tests/              unit tests, mirroring src/
```
