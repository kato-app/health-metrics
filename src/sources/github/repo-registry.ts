import type { Logger } from "../../logging/logger.js";
import type { GitHubSource, RepoRef } from "./source.js";

/**
 * The repositories metrics should collect from: every repo in the organisation
 * that has at least one release, minus the configured exclusions.
 *
 * Discovery is a GraphQL scan of the whole organisation, so a registry runs it
 * at most once per process, the first time any metric asks. Metrics that never
 * ask (or commands like `list`) never trigger it. If discovery fails, every
 * caller in the run gets the same error rather than a silently stale list.
 */
export interface RepoRegistry {
  list(): Promise<readonly RepoRef[]>;
}

export interface RepoRegistryOptions {
  readonly github: GitHubSource;
  readonly owner: string;
  readonly excludeRepos: readonly string[];
  readonly logger: Logger;
}

export function createRepoRegistry(options: RepoRegistryOptions): RepoRegistry {
  const { github, owner, excludeRepos, logger } = options;
  let pending: Promise<readonly RepoRef[]> | undefined;

  async function discover(): Promise<readonly RepoRef[]> {
    const discovered = await github.listReposWithReleases(owner);
    const excluded = new Set(excludeRepos);
    const kept = discovered.filter((name) => !excluded.has(name));

    const unmatched = excludeRepos.filter((name) => !discovered.includes(name));
    if (unmatched.length) {
      logger.warn("Excluded repositories were not among those discovered; check config.json for typos", {
        excludeRepos: unmatched,
      });
    }
    logger.info("Repositories selected for metrics", {
      owner,
      repos: kept,
      excluded: discovered.filter((name) => excluded.has(name)),
    });

    return kept.map((name) => ({ owner, name }));
  }

  return {
    list() {
      pending ??= discover();
      return pending;
    },
  };
}
