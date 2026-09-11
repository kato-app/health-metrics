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

## Google Sheets

**Auth.** The CLI authenticates as a Google service account, which needs no browser flow or token refresh:

1. In Google Cloud, create a project (or reuse one) and enable the **Google Sheets API**.
2. Create a service account, then create a JSON key for it and save the file outside version control (the default `.gitignore` already ignores `google-service-account*.json`).
3. Share the target spreadsheet with the service account's email address as an **Editor**.
4. Point `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` in `.env` at the key file (relative paths resolve from the project root).

**Layout.** Each metric owns one tab named exactly after the metric, with the metric's columns as the header row. The tab and header are created on the first write; an existing tab must have a header that matches the metric's columns exactly, otherwise the run fails before writing anything. New rows are appended after the last row with data.

**Encoding.** Rows are written with the `RAW` input option, so Sheets never reinterprets text: a release named `6.5` stays text and a value beginning with `=` is never treated as a formula. Date-time cells are the one exception. They are written as native Sheets serial numbers, and their columns are given the number format `yyyy-mm-dd hh:mm:ss` after every write (rows inserted by an append do not inherit column formatting), so they sort, filter and chart as dates and read back as exactly the text the metric wrote. Blank cells read back as `null`; every other value reads back as text, which is why metrics compare ids as strings.

If someone changes the date column's display format in the sheet, the watermark becomes unreadable: the metric logs a warning and re-pages from `startDate`, and id de-duplication keeps the tab free of duplicates.

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

### deployment-frequency

One row per production deployment, where a deployment is a **published GitHub release** in any of the configured repositories.

**Source.** `GET /repos/{owner}/{repo}/releases` via Octokit, 100 per page, for each repository in `config.github.repos`. GitHub returns releases newest-created first.

**Columns**, in order:

| Column | From |
| --- | --- |
| `published_at` | `published_at`, formatted `YYYY-MM-DD HH:MM:SS` UTC |
| `repo` | `owner/name`, e.g. `kato-app/kato` |
| `id` | release `id` (unique per release; used for de-duplication) |
| `author_login` | `author.login`, blank if GitHub reports no author |
| `tag_name` | `tag_name` |
| `name` | release `name` |
| `target_commitish` | branch or commit the release was cut from |
| `html_url` | link to the release page |

**Exclusion rules.**

- Drafts are excluded. They have no `published_at` and will be picked up once published.
- Prereleases are excluded. A prerelease later promoted to a full release is picked up at that point.
- Releases published before `config.startDate` are excluded.
- Releases whose `id` is already in the sheet are excluded, so a re-run or a run that failed part-way never produces duplicates.

**Delta collection.** The watermark is the newest `published_at` already in the tab. On an empty tab, the metric backfills from `startDate`. Otherwise it pages GitHub only as far back as the watermark **minus a 30-day grace window** (never earlier than `startDate`), and stops at the first release created before that point. New rows are sorted oldest first by `published_at`, then `id`, before being appended.

Why the grace window: GitHub orders the listing by `created_at`, which is the date of the release's commit, but we watermark on `published_at`. A draft created before the watermark and published after it would sit below a strict cutoff and be missed. Paging 30 days past the watermark, with ids de-duplicated against the sheet, catches any such release published within that window at the cost of re-reading a month of releases (usually well within one 100-item page).

If the tab has rows but none carries a readable `published_at`, a warning is logged and the metric backfills from `startDate`; id de-duplication still prevents duplicate rows.

**Failure behaviour.** If any configured repository cannot be read (404, 403, network), the whole metric run fails and nothing is written for it. Other metrics in a `--all` run are unaffected.

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
