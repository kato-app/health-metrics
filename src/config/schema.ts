import { z } from "zod";

export const configSchema = z.object({
  spreadsheetId: z.string().min(1),
  /** Earliest date (inclusive, UTC) from which metrics are backfilled, as YYYY-MM-DD. */
  startDate: z.iso.date(),
  github: z.object({
    /** GitHub organisation whose repositories are discovered. Must be an organisation, not a user. */
    owner: z.string().min(1),
    /**
     * Repositories to leave out of every metric even though discovery found
     * releases in them. Names only, without the owner. Empty means no exclusions.
     */
    excludeRepos: z.array(z.string().min(1)).default([]),
  }),
  jira: z.object({
    /** Jira projects to collect issues from, each mapped to the team it belongs to. */
    projects: z
      .array(
        z.object({
          /** Jira project key, e.g. `GR`. */
          key: z.string().min(1),
          /** Human-readable team name written to the sheet, e.g. `Growth`. */
          team: z.string().min(1),
        }),
      )
      .min(1),
    /**
     * Status names (case-insensitive) whose first entry marks the start of an
     * issue's cycle. If an issue never enters one of these, the first status in
     * Jira's "In Progress" category is used instead.
     */
    startStatuses: z.array(z.string().min(1)).min(1).default(["In Progress"]),
    /** Resolutions that mean the issue was closed without being delivered; such issues are never measured. */
    excludedResolutions: z.array(z.string().min(1)).default(["Won't Do", "Duplicate", "Cannot Reproduce"]),
  }),
  logging: z.object({
    /** Project-relative path of the JSON log file that is appended to on every run. */
    file: z.string().min(1),
  }),
});

export type Config = z.infer<typeof configSchema>;
export type JiraProject = Config["jira"]["projects"][number];

export const envSchema = z.object({
  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required"),
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: z.string().min(1, "GOOGLE_SERVICE_ACCOUNT_KEY_FILE is required"),
  /** Jira Cloud site, e.g. https://example.atlassian.net. https only: the token travels as basic auth. */
  ATLASSIAN_BASE_URL: z.url({ protocol: /^https$/ }),
  ATLASSIAN_EMAIL: z.email(),
  ATLASSIAN_TOKEN: z.string().min(1, "ATLASSIAN_TOKEN is required"),
});

export type Env = z.infer<typeof envSchema>;
