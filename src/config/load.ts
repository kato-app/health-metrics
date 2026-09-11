import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { configSchema, envSchema, type Config, type Env } from "./schema.js";

/**
 * Nearest ancestor directory of this module that holds a package.json. Walking
 * up (rather than a fixed number of levels) keeps the answer correct whether
 * this file runs from `src/` via tsx or from `dist/src/` after `npm run build`.
 */
function findProjectRoot(from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) throw new Error(`No package.json found above ${from}`);
  }
}

/** Absolute path of the project root, independent of the current working directory. */
export const projectRoot = findProjectRoot(path.dirname(fileURLToPath(import.meta.url)));

/** Resolves a path against the project root; an absolute path is returned unchanged. */
export function fromProjectRoot(...segments: string[]): string {
  return path.resolve(projectRoot, ...segments);
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

function formatIssues(prefix: string, error: z.ZodError): string {
  const lines = error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
  return `${prefix}\n${lines.join("\n")}`;
}

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(formatIssues("Invalid config.json:", result.error));
  return result.data;
}

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(formatIssues("Missing or invalid environment:", result.error));
  return result.data;
}

export function loadConfig(file = fromProjectRoot("config.json")): Config {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`Cannot load ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseConfig(json);
}

/** Loads `.env` from the project root (if present) into process.env, then validates it. */
export function loadEnv(file = fromProjectRoot(".env")): Env {
  if (existsSync(file)) process.loadEnvFile(file);
  return parseEnv(process.env);
}

/**
 * Absolute path of the service account key file. Checked up front so a typo in
 * `.env` fails with a clear message instead of an auth error on the first
 * Sheets request.
 */
export function resolveKeyFile(env: Env): string {
  const file = fromProjectRoot(env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE);
  if (!existsSync(file)) throw new ConfigError(`GOOGLE_SERVICE_ACCOUNT_KEY_FILE points to ${file}, which does not exist`);
  return file;
}
