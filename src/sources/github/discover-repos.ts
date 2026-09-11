import { z } from "zod";
import type { Logger } from "../../logging/logger.js";

/** Lists an organisation's repositories with how many releases each has, 50 per page. */
export const REPOS_WITH_RELEASES_QUERY = `
query($org: String!, $cursor: String) {
  organization(login: $org) {
    repositories(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        name
        releases {
          totalCount
        }
      }
    }
  }
}`;

/** A node is null when the token cannot see that repository; `organization` is null when it cannot see the org. */
const repositoryNodeSchema = z.object({ name: z.string(), releases: z.object({ totalCount: z.number().int() }) });

export const repositoriesPageSchema = z.object({
  organization: z
    .object({
      repositories: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(repositoryNodeSchema.nullable()),
      }),
    })
    .nullable(),
});

export type RepositoriesPage = z.infer<typeof repositoriesPageSchema>;

/** Runs one GraphQL query with variables and returns the raw `data` object. */
export type GraphqlExecutor = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

/**
 * Names of every repository in `org` that has at least one release (of any
 * kind, drafts and prereleases included), in the order GitHub returns them.
 * Follows `endCursor` until the last page. Any failure propagates.
 */
export async function discoverReposWithReleases(execute: GraphqlExecutor, org: string, logger: Logger): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | null = null;
  let scanned = 0;

  for (let page = 1; ; page += 1) {
    const raw = await execute(REPOS_WITH_RELEASES_QUERY, { org, cursor });
    const parsed = repositoriesPageSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Unexpected GraphQL payload listing repositories of ${org} (page ${page}): ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }
    if (!parsed.data.organization) throw new Error(`GitHub organisation "${org}" was not found or is not visible to this token`);

    const { pageInfo, nodes } = parsed.data.organization.repositories;
    for (const node of nodes) {
      if (!node) continue;
      scanned += 1;
      if (node.releases.totalCount > 0) names.push(node.name);
    }
    logger.debug("Fetched repositories page", { org, page, repos: nodes.length, withReleases: names.length });

    // GitHub sets endCursor on the last page too, so hasNextPage alone decides whether to continue.
    if (!pageInfo.hasNextPage) {
      logger.info("Discovered repositories with releases", { org, scanned, withReleases: names.length, pages: page });
      return names;
    }
    if (pageInfo.endCursor === null) {
      throw new Error(`GraphQL reported more repositories for ${org} but returned no cursor (page ${page})`);
    }
    cursor = pageInfo.endCursor;
  }
}
