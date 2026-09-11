import { Octokit } from "octokit";
import type { Logger } from "../../logging/logger.js";
import { discoverReposWithReleases } from "./discover-repos.js";
import { releaseSchema, repoFullName, type GitHubRelease, type GitHubSource, type RepoRef } from "./source.js";

export interface OctokitSourceOptions {
  readonly token: string;
  readonly logger: Logger;
}

/** `GitHubSource` backed by the official Octokit client, which handles auth, rate limits and retries. */
export function createOctokitSource(options: OctokitSourceOptions): GitHubSource {
  const octokit = new Octokit({ auth: options.token, log: octokitLogger(options.logger) });
  const logger = options.logger.child({ source: "github" });

  return {
    async *listReleases(repo: RepoRef): AsyncIterable<GitHubRelease> {
      const pages = octokit.paginate.iterator(octokit.rest.repos.listReleases, {
        owner: repo.owner,
        repo: repo.name,
        per_page: 100,
      });
      const fullName = repoFullName(repo);
      let page = 0;
      for await (const response of pages) {
        page += 1;
        logger.debug("Fetched releases page", { repo: fullName, page, count: response.data.length });
        for (const raw of response.data) {
          const parsed = releaseSchema.safeParse(raw);
          if (!parsed.success) {
            throw new Error(`Unexpected release payload from ${fullName} (id ${raw.id}): ${parsed.error.message}`, {
              cause: parsed.error,
            });
          }
          yield parsed.data;
        }
      }
    },

    listReposWithReleases(org: string): Promise<string[]> {
      // octokit.graphql posts to https://api.github.com/graphql with the same token.
      return discoverReposWithReleases((query, variables) => octokit.graphql(query, variables), org, logger);
    },
  };
}

/** Routes Octokit's own diagnostics (rate-limit waits, retries) through our logger. */
function octokitLogger(logger: Logger) {
  const child = logger.child({ source: "octokit" });
  return {
    debug: (msg: string) => child.debug(msg),
    info: (msg: string) => child.debug(msg),
    warn: (msg: string) => child.warn(msg),
    error: (msg: string) => child.error(msg),
  };
}
