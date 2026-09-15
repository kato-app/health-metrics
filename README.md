# HealthMetrics

A small Node.js/TypeScript CLI that collects engineering health metrics from their source systems and writes them to a Google Sheet, one tab per metric. Most metrics append only the delta since the last run; a snapshot metric replaces its tab with the current picture.

## Setup

Requirements: Node 26+ and npm.

```sh
npm install
cp .env.example .env   # then fill in the values
```

`.env` holds secrets and is never committed:

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | Fine-grained personal access token for the organisation in `github.owner` with repository permissions Metadata, Contents and Pull requests (all read). |
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | Path to a Google service account key JSON. Share the spreadsheet with the service account's email as an Editor. |
| `ATLASSIAN_BASE_URL` | Jira Cloud site, e.g. `https://your-site.atlassian.net`. |
| `ATLASSIAN_EMAIL` | Email of the Atlassian user the API token belongs to. |
| `ATLASSIAN_TOKEN` | Atlassian API token created at https://id.atlassian.com/manage-profile/security/api-tokens. It inherits that user's permissions and expires after at most a year. |

`config.json` holds non-secret settings and is committed:

| Key | Purpose |
| --- | --- |
| `spreadsheetId` | The Google Sheet all metrics write to. |
| `startDate` | Earliest date (UTC, inclusive) backfilled when a metric's tab is empty. |
| `github.owner` | GitHub **organisation** whose repositories are discovered (see [Repository discovery](#repository-discovery)). A user account will not work. |
| `github.excludeRepos` | Repository names (without the owner) to leave out of every metric even though they have releases. Optional; defaults to `[]`. |
| `jira.startStatuses` | Status names (case-insensitive) whose first entry starts an issue's cycle. Optional; defaults to `["In Progress"]`. An issue that never enters one falls back to its first status in Jira's "In Progress" category. |
| `jira.excludedResolutions` | Resolutions meaning "closed without delivering"; such issues are never measured. Optional; defaults to `["Won't Do", "Duplicate", "Cannot Reproduce"]`. |
| `jira.excludedStatuses` | Status names (case-insensitive) meaning "shelved rather than delivered"; such issues are never measured even if their resolution is Done. Optional; defaults to `["Archived"]`. |
| `jira.excludedIssueTypes` | Issue type names (case-insensitive) that are containers rather than work; such issues are never measured even when a pull request names them. Optional; defaults to `["Epic"]`. |
| `jira.projects` | Jira projects to collect issues from, each as `{ "key": "GR", "team": "Kato Growth" }`. Only these projects are queried; metrics that read Jira write the team name to the sheet alongside the project key. |
| `changeFailure.settlingDays` | A release is judged for change failure only once this many days have passed since it was published, so late remediation is caught. Optional; defaults to `14`. |
| `changeFailure.keylessAttributionDays` | A hotfix with no issue key is pinned on the previous release only if that release is at most this many days older. Optional; defaults to `3`. |
| `changeFailure.regressionLabel` | Jira label that marks a bug as a regression caused by a recent release. A bug with an Affects Version counts too. Optional; defaults to `"regression"`. |
| `logging.file` | Project-relative path of the JSON log file, appended to on every run. |

## CLI

```sh
npm run metrics -- list                         # show registered metrics
npm run metrics -- run <name>                   # collect one metric and write new rows
npm run metrics -- run --all                    # collect every metric; each runs independently
npm run metrics -- run <name> --dry-run         # collect and log rows without writing
npm run metrics -- run <name> --full            # re-check everything since startDate, not just what is newer than the sheet
npm run metrics -- run --all --verbose          # debug-level console output
```

`--full` ignores each metric's watermark and re-evaluates from `startDate`. Rows already in the sheet are still skipped by id or key, so it cannot create duplicates; it exists to pick up anything a normal run's window missed, at the cost of a first-run-sized set of API calls.

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
4. Point `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` in `.env` at the key file (relative paths resolve from the project root). The run aborts before contacting anything if the file does not exist.

**Layout.** Each metric owns one tab named exactly after the metric, with the metric's columns as the header row starting at column A. The tab and header are created on the first write; an existing tab's first cells must match the metric's columns exactly (a blank first row above data counts as a mismatch), otherwise the run fails before writing anything. The metric only ever reads and writes its own block of columns, so you can add helper columns and formulas to the right of the data: they are ignored by the header check, and new rows are written directly under the last row that has data in the metric's columns even if a helper formula runs further down. Those rows are filled in place rather than inserted, so formulas filled down beside the data stay on the rows they refer to; the sheet only grows when the block reaches its last row. Rows left blank across all metric columns (for example data cleared by hand) are ignored when reading. A snapshot metric clears only its own block below the header before writing, so helper columns survive that too. The tab list is fetched once per run and a header verified while reading is not re-read before writing.

**Encoding.** Rows are written with the `RAW` input option, so Sheets never reinterprets text: a release named `6.5` stays text and a value beginning with `=` is never treated as a formula. Date-time cells are the one exception. They are written as native Sheets serial numbers, and any column that holds one in the rows being written is given the number format `yyyy-mm-dd hh:mm:ss` after every write (rows added at the end of the sheet by an append do not inherit column formatting), so they sort, filter and chart as dates and read back as exactly the text the metric wrote. Blank cells read back as `null`; every other value reads back as text, which is why metrics compare ids as strings.

If someone changes the date column's display format in the sheet, the watermark becomes unreadable: the metric logs a warning and re-pages from `startDate`, and id de-duplication keeps the tab free of duplicates.

**Errors.** A failed Sheets request is reported as `Google Sheets request failed (HTTP <status>): <API message>` with a hint for the common setup mistakes: `403` means the spreadsheet is not shared with the service account (or the Sheets API is not enabled in its project) and `404` means `spreadsheetId` is wrong. The original API error is logged as the `cause`.

## Logging

Console output is human-readable at `info` level (`debug` with `--verbose`). Every run also appends newline-delimited JSON at `debug` level to the file named in `config.json`, so local history survives between runs. The application talks to a `Logger` interface in `src/logging/logger.ts`; the pino implementation behind it is the only place a real transport is configured, so shipping logs elsewhere later is a change confined to that module.

## How a run works

1. Load and validate `config.json` and `.env`. Invalid or missing values abort before anything is contacted.
2. Resolve the requested metric(s) from the registry in `src/metrics/index.ts`.
3. For each metric, in turn:
   1. Read the rows already in the metric's sheet tab (append metrics only).
   2. Ask the metric to collect: for an **append** metric, only rows newer than what is there (see each metric's rules below); for a **snapshot** metric, the complete current picture.
   3. Validate every row has exactly the metric's columns.
   4. Append metrics add their rows below the existing ones, oldest first, and write nothing when there is nothing new. Snapshot metrics clear everything below the header in their own columns and write the new rows, so their tab always shows the latest state and may legitimately end up empty. The clear and the write are separate API calls: if the write fails, the tab stays empty (and the run exits non-zero) until the next successful run.
4. A failure in one metric is logged and does not stop the others. The process exits non-zero if any failed.

## Repository discovery

Metrics do not use a fixed list of repositories. The first time a metric in a run asks for repositories, the app queries the GitHub GraphQL endpoint (`https://api.github.com/graphql`, same token as the REST calls) for every repository in `github.owner`, 50 per page, following `endCursor` until `hasNextPage` is false. Every repository with `releases.totalCount > 0` is kept, in the order GitHub returns them, and any name listed in `github.excludeRepos` is then removed. The result is cached for the rest of the run, so `run --all` discovers once however many metrics use it, and `metrics list` or a dry run of a non-GitHub metric never touches GitHub.

Rules and consequences:

- Archived repositories and forks are included if they have releases. Use `github.excludeRepos` to leave one out.
- `totalCount` counts drafts and prereleases, so a repository whose only releases are drafts is discovered; the metrics' own exclusion rules then produce no rows for it.
- A repository that is deleted, transferred, or loses all its releases simply stops being discovered. Rows already written for it stay in the sheet.
- An exclusion that matches no discovered repository logs a warning, since it is probably a typo.
- If discovery fails (network, token without access to the organisation), every metric that needs repositories fails for that run. There is no fallback to a stale list.

## Metrics

Each metric owns one tab in the spreadsheet, named exactly after the metric. Metrics emit dates as `YYYY-MM-DD HH:MM:SS` text in UTC; the sink stores them as native date-times (see Google Sheets above).

### deployment-frequency

One row per production deployment, where a deployment is a **published GitHub release** in any of the discovered repositories.

**Source.** `GET /repos/{owner}/{repo}/releases` via Octokit, 100 per page, for each repository returned by [Repository discovery](#repository-discovery). GitHub returns releases newest-created first.

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

**Failure behaviour.** If repository discovery fails or any discovered repository cannot be read (404, 403, network), the whole metric run fails and nothing is written for it. Other metrics in a `--all` run are unaffected.

### cycle-time

One row per Jira issue that has been **delivered to production**, for the projects in `jira.projects`. All teams share the tab; the `project` and `team` columns tell them apart.

**Definition.** Cycle time runs from the moment the issue was first moved into `In Progress` (configurable via `jira.startStatuses`) to the moment the GitHub release containing the issue's **last** pull request was published. Lead time runs from the issue's creation to that same release. Both are **calendar days to two decimals: weekends and holidays are included**, so a story started on Friday and released on Monday shows about 3 days. Remind consumers of this when they read the sheet.

**Sources.**

- Jira: `GET /rest/api/3/search/jql` with `expand=changelog` for issues in the configured projects whose status category is Done, resolved within the query window. `GET /rest/api/3/status` maps every status to its category. The development panel's dev-status endpoints list the pull requests GitHub for Jira has linked to each issue by branch name, commit message or title.
- GitHub: the [Repository discovery](#repository-discovery) list, each repository's published releases since `startDate` (to build a pull request → release index from the generated release notes), and `GET /repos/{owner}/{repo}/pulls/{n}` for merge times.

**Columns**, in order:

| Column | Meaning |
| --- | --- |
| `released_at` | When the release containing the issue's last pull request was published (UTC). The end of the cycle and the watermark. |
| `project` | Jira project key, e.g. `GR`. |
| `team` | Team name from `jira.projects`. |
| `issue_key` | e.g. `GR-304`. Unique per row; used for de-duplication. |
| `issue_type` | Story, Bug, Task, ... |
| `summary` | Issue title. |
| `created_at` | Issue creation. Start of lead time. |
| `started_at` | First move into a status in `jira.startStatuses`, or failing that into any status of Jira's "In Progress" category. Start of cycle time. Blank if neither ever happened. |
| `done_at` | Last move into a Done-category status in Jira, or the resolution date if the changelog has none. |
| `last_merged_at` | Merge time of the issue's most recently merged pull request. |
| `pr_count` | Merged pull requests in collected repositories that count for the issue (see below). |
| `repos` | Repositories those pull requests were merged into, comma-separated. |
| `release_tags` | Releases that shipped them, as `repo@tag`, comma-separated. |
| `cycle_time_days` | `released_at − started_at` in calendar days. Blank when `started_at` is blank. |
| `lead_time_days` | `released_at − created_at` in calendar days. |

**Which pull requests count.** Jira links a pull request to every issue mentioned in its commits or description, so a follow-up under another ticket can attach itself to an issue months later and drag its release date forward. The metric therefore uses only the linked pull requests whose branch name or title names the issue's own key (any case, any separator). If none of them do, it falls back to the linked pull requests that name no configured issue at all, since some teams put the key in commit messages alone. A pull request that names a different configured issue is never counted for this one; an issue whose only links are other tickets' work therefore has no pull request and is not measured. A dropped pull request neither ends the cycle nor, while still open, defers the issue. Whenever one is dropped for naming another configured issue, the run logs a warning listing the pull requests kept (possibly none) and those ignored, each with the other issue's key.

**Exclusion and deferral rules.** An issue produces no row when it:

- is a sub-task (its parent is measured instead);
- is of a type listed in `jira.excludedIssueTypes` (containers, e.g. Epic), even when a pull request names its key: an epic closed after its stories shipped would otherwise show a negative cycle time;
- has a resolution listed in `jira.excludedResolutions`;
- is in a status listed in `jira.excludedStatuses` (shelved, e.g. Archived), whatever its resolution;
- is already in the sheet;
- still has a counted pull request that is neither merged nor declined (deferred: it will be measured once everything has merged and shipped);
- has no counted, merged pull request in a collected repository. Spikes, investigations and non-code tasks therefore never appear. Declined pull requests and pull requests in other repositories are ignored;
- has a merged pull request that no published release lists yet (deferred until the release is cut);
- was released before `startDate`.

Each run logs a count per reason at `info` and the individual decisions at `debug`. A row whose release predates its `started_at` (negative `cycle_time_days`, usually a ticket raised after the work or a pull request linked to the wrong issue) is still written but logged at `warn` with the issue key.

**Delta collection.** The watermark is the newest `released_at` in the tab. Each run queries Jira for issues resolved on or after the watermark **minus 90 days** (never earlier than `startDate`), skips keys already in the sheet before any further lookups, and evaluates the rest. The long window exists because an issue can be Done in Jira weeks before its pull request ships; deferred issues are re-evaluated on every run until they qualify. Rows are appended oldest release first, then by issue key.

If the tab has rows but none carries a readable `released_at`, a warning is logged and Jira is queried from `startDate`; key de-duplication still prevents duplicate rows.

**Unlinked pull requests.** Every run logs one `info` line counting the pull requests shipped in releases newer than the watermark that cycle time cannot attribute to a configured Jira issue: those with no issue key in the title, and a count per foreign Jira project for the rest. The full, always-current list is the [unlinked-prs](#unlinked-prs) tab.

**Aggregating in the sheet.** The tab holds raw rows only. For a weekly median, 70th and 85th percentile per team, add a summary tab with, for example:

```
=PERCENTILE(FILTER('cycle-time'!N:N, 'cycle-time'!C:C=$A2, 'cycle-time'!A:A>=$B2, 'cycle-time'!A:A<$B2+7), 0.5)
```

where column `A` of the summary holds the team and `B` the week start; swap `0.5` for `0.7` and `0.85`. Column `N` is `cycle_time_days`; use `O` for lead time.

### unlinked-prs

A **snapshot** of every pull request shipped in a published release since `startDate` that [cycle-time](#cycle-time) cannot attribute to a configured Jira issue. It is a safety net for sidestepped process: work through it with the team and it should trend to empty. Every run re-audits all releases since `startDate` and rewrites the tab, so fixing a pull request removes its row on the next run. `--full` changes nothing here because a snapshot already covers everything.

**Sources.** The same release index as cycle-time (GitHub release notes, which also supply the author login), plus one Jira JQL query, `project in (<configured>) AND development[pullrequests].all = 0 AND updated >= "<startDate>"`, which returns the issues that have no pull request linked at all. An issue not touched since `startDate` falls outside that query, so a pull request naming only such an issue is taken as linked.

**Columns**, in order:

| Column | Meaning |
| --- | --- |
| `released_at` | When the release that shipped the pull request was published (UTC). |
| `repo` | `owner/name`. |
| `pr_number` | Pull request number. |
| `author` | GitHub login of the author, as listed in the release notes. Who to talk to. |
| `title` | Pull request title as shipped. |
| `reason` | One of the three reasons below. |
| `issue_keys` | Issue keys found in the title, if any. |
| `release_tag` | The release that shipped it. |
| `url` | Link to the pull request. |

**Reasons.**

- `No issue key in title`: nothing that looks like an issue key. Add the key to the title; GitHub for Jira re-links a pull request when its title changes.
- `Issue key is not a configured Jira project`: the title names a project that is not in `jira.projects`, such as a legacy project. A strict key like `AWA-10290` counts anywhere in the title; a branch-derived one like `Awa 10288 ...` only at its start, so "Upgrade to Node 22" is reported as key-less instead.
- `Jira issue has no linked pull request`: the title names a configured issue, but Jira shows no development information for it, so the link never happened. Usually the branch or title was edited after the fact; re-saving the title or adding the key to a commit fixes it. A title naming several issues counts as linked if any of them is linked in Jira.

Branch-sync and version-cut pull requests such as "Main to Release", "Release for v70.7", "v73.15 Release", "kato v76.3", "Update release branch with main" or "Merge pull request #…" are never listed; a bare version or "Release …" must be the whole title, and a word before a version is only a version cut when the version carries its `v`, so "V2 endpoints", "Node 22" and "Phase 2 release" are still listed. Matching is tolerant of GitHub's branch-derived titles, so `Gr 272 add users` counts as `GR-272`; the project's first letter must be upper case so that "Retry at 3 seconds" does not read as `AT-3`. Rows are ordered oldest release first, then by repository and number.

### change-failure

One row per **published release** in every collected repository (the same releases as deployment-frequency), saying whether that release turned out to need remediation and how we know. Change failure rate is the share of rows with `failed` = TRUE, computed in the sheet per week with the same LET pattern as the other metrics.

**What counts as a failure.** There is no incident tool or incident process, so remediation is inferred from what the teams already do, in this order of trust:

1. **Hotfix or revert pull requests.** A later release whose notes list a PR titled "hotfix" (any spelling: `Hotfix`, `HOTFIX`, `hot fix`) or starting with "Revert". If the title carries a Jira issue key that exists, the failed release is the one that was live in that repository when the issue was created. Otherwise, if the fixing release is a patch tag, its base failed. Otherwise the release immediately before the fix failed, but only if it is at most `changeFailure.keylessAttributionDays` older; anything older is not guessed at and goes to [unclaimed-hotfixes](#unclaimed-hotfixes) instead.
2. **Patch tags.** A release tagged `vX.Y.Z` with a non-zero `Z` patches `vX.Y` (or `vX.Y.(Z-1)`); `v68.0.1` patches `v68`. Two-component tags are ordinary releases.
3. **Jira regressions.** A Bug carrying the `changeFailure.regressionLabel` label or an Affects Version, with a merged pull request in a collected repository: the release live in that repository when the bug was created failed. Bugs with neither marker are ignored, because a customer-found bug can be months old. Regression bugs with no linked pull request cannot be tied to a repository and are skipped with a log line. Nobody sets either marker yet, so this signal starts empty.

Rollbacks are invisible: the GitHub deployments API is used only for per-ticket dev environments, and production deployments are not recorded anywhere we can read.

**Columns**, in order:

| Column | Meaning |
| --- | --- |
| `released_at` | When the release was published (UTC). The watermark. |
| `repo` | `owner/name`. |
| `tag` | Release tag. `repo` + `tag` identify the row. |
| `failed` | TRUE when any signal below is present. |
| `hotfix` | Hotfix pull requests attributed to this release, as `owner/repo#n "title"`, `;`-separated. Blank if none. |
| `revert` | Revert pull requests attributed to this release, same format. |
| `patch_tag` | Patch releases of this release, e.g. `v73.36.1`. |
| `jira_regression` | Regression bug keys attributed to this release. |
| `remediated_by` | Distinct tags of the releases that shipped the fixes. |
| `first_remediation_at` | Earliest remediation: the fixing release's publish time, or the regression bug's creation. |
| `days_to_remediation` | `first_remediation_at − released_at`, calendar days to two decimals. |

**Settling and delta.** A release is judged only once `changeFailure.settlingDays` have passed since it was published, so each run writes the releases that settled since the last one. The watermark is the newest `released_at` in the tab; each run re-examines releases from the watermark minus 30 days and skips those already present, so a skipped week is caught up. A remediating release is itself a change and gets its own row, which may in turn be flagged. Rows are ordered oldest release first.

### unclaimed-hotfixes

A **snapshot** of every hotfix, revert or patch release since `startDate` that [change-failure](#change-failure) could not pin on an earlier release, with the reason: a title with no issue key whose previous release is too old, an issue key Jira does not know or that predates every indexed release, or a patch tag whose base was released before `startDate`. Columns: released_at, repo, tag, signal, evidence, author, reason. Adding the issue key to the pull request title fixes the first two kinds on the next run; the third clears itself as the start date recedes. `--full` changes nothing here because a snapshot already covers everything.

## Adding a metric

1. Create `src/metrics/<name>/` with a factory that returns a `Metric` (see `src/core/metric.ts`): a name, description, ordered `columns`, and a `collect` function. An append metric (the default) receives the existing rows and returns only new ones, oldest first; a snapshot metric (`mode: "snapshot"`) receives no existing rows and returns the complete current picture, which replaces its tab. Both receive `full`, which append metrics honour by ignoring their watermark. A metric that reads GitHub repositories gets them from `repos.list()` inside `collect`, never at construction time, so `metrics list` stays offline and discovery runs once per run.
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
  sources/          typed clients for source systems (GitHub, Jira)
tests/              unit tests, mirroring src/
```
