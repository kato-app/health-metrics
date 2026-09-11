import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "not a valid date");

export const configSchema = z.object({
  spreadsheetId: z.string().min(1),
  /** Earliest date (inclusive, UTC) from which metrics are backfilled. */
  startDate: isoDate,
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
