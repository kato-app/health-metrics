import { z } from "zod";

export const configSchema = z.object({
  spreadsheetId: z.string().min(1),
  /** Earliest date (inclusive, UTC) from which metrics are backfilled, as YYYY-MM-DD. */
  startDate: z.iso.date(),
  github: z.object({
    owner: z.string().min(1),
    repos: z.array(z.string().min(1)).min(1),
  }),
  logging: z.object({
    /** Project-relative path of the JSON log file that is appended to on every run. */
    file: z.string().min(1),
  }),
});

export type Config = z.infer<typeof configSchema>;

export const envSchema = z.object({
  GITHUB_TOKEN: z.string().min(1, "GITHUB_TOKEN is required"),
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: z.string().min(1, "GOOGLE_SERVICE_ACCOUNT_KEY_FILE is required"),
});

export type Env = z.infer<typeof envSchema>;
