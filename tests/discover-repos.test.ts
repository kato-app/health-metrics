import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noopLogger } from "../src/logging/logger.js";
import {
  REPOS_WITH_RELEASES_QUERY,
  discoverReposWithReleases,
  type GraphqlExecutor,
  type RepositoriesPage,
} from "../src/sources/github/discover-repos.js";

type Node = { name: string; releases: { totalCount: number } } | null;

function page(nodes: Node[], endCursor: string | null): RepositoriesPage {
  return {
    organization: {
      repositories: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes },
    },
  };
}

function repo(name: string, totalCount: number): Node {
  return { name, releases: { totalCount } };
}

/** Serves pre-built pages keyed by the cursor they are requested with, recording every call. */
function fakeGraphql(pages: Record<string, unknown>): GraphqlExecutor & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const execute = (async (query: string, variables: Record<string, unknown>) => {
    calls.push(variables);
    assert.equal(query, REPOS_WITH_RELEASES_QUERY);
    const key = variables.cursor === null ? "first" : String(variables.cursor);
    if (!(key in pages)) throw new Error(`Unexpected cursor ${key}`);
    return pages[key];
  }) as GraphqlExecutor & { calls: Record<string, unknown>[] };
  execute.calls = calls;
  return execute;
}

describe("discoverReposWithReleases", () => {
  it("follows endCursor across every page and keeps only repos with releases, in API order", async () => {
    const graphql = fakeGraphql({
      first: page([repo("kato", 267), repo("docs", 0), repo("kato-settings", 48)], "c1"),
      c1: page([repo("infra", 0), repo("mobile", 3)], "c2"),
      c2: page([repo("archived-thing", 1), null], null),
    });

    const names = await discoverReposWithReleases(graphql, "kato-app", noopLogger);

    assert.deepEqual(names, ["kato", "kato-settings", "mobile", "archived-thing"]);
    assert.deepEqual(graphql.calls, [
      { org: "kato-app", cursor: null },
      { org: "kato-app", cursor: "c1" },
      { org: "kato-app", cursor: "c2" },
    ]);
  });

  it("handles a single page and an organisation with no qualifying repos", async () => {
    const graphql = fakeGraphql({ first: page([repo("empty", 0)], null) });
    assert.deepEqual(await discoverReposWithReleases(graphql, "kato-app", noopLogger), []);
    assert.equal(graphql.calls.length, 1);
  });

  it("fails clearly when the organisation is not visible", async () => {
    const graphql = fakeGraphql({ first: { organization: null } });
    await assert.rejects(discoverReposWithReleases(graphql, "nope", noopLogger), /organisation "nope" was not found/);
  });

  it("fails on a malformed payload rather than returning a partial list", async () => {
    const graphql = fakeGraphql({ first: { organization: { repositories: { nodes: "oops" } } } });
    await assert.rejects(discoverReposWithReleases(graphql, "kato-app", noopLogger), /Unexpected GraphQL payload/);
  });

  it("refuses to loop when GitHub says there is another page but gives no cursor", async () => {
    const graphql = fakeGraphql({
      first: { organization: { repositories: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } } },
    });
    await assert.rejects(discoverReposWithReleases(graphql, "kato-app", noopLogger), /no cursor/);
  });

  it("propagates transport errors", async () => {
    const failing: GraphqlExecutor = async () => {
      throw new Error("Bad credentials");
    };
    await assert.rejects(discoverReposWithReleases(failing, "kato-app", noopLogger), /Bad credentials/);
  });
});
