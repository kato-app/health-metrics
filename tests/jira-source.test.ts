import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noopLogger } from "../src/logging/logger.js";
import { createJiraClient, describeJiraError } from "../src/sources/jira/jira-client.js";
import { parseJiraDate } from "../src/sources/jira/source.js";

const BASE = "https://example.atlassian.net";

type Route = (url: URL) => { status?: number; body: unknown };

/** Fake fetch that dispatches on pathname and records every request. String bodies are sent verbatim. */
function fakeFetch(routes: Record<string, Route>) {
  const requests: URL[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requests.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("me@example.com:tok").toString("base64")}`);
    const route = routes[url.pathname];
    if (!route) return new Response("no route", { status: 404 });
    const { status = 200, body } = route(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return Object.assign(impl, { requests });
}

function client(routes: Record<string, Route>) {
  const fetch = fakeFetch(routes);
  return { fetch, jira: createJiraClient({ baseUrl: `${BASE}/`, email: "me@example.com", token: "tok", logger: noopLogger, fetch }) };
}

function rawIssue(key: string, histories: unknown[], total = histories.length) {
  return {
    id: key.replace(/\D/g, ""),
    key,
    fields: {
      summary: `Do ${key}`,
      issuetype: { name: "Story", subtask: false },
      project: { key: key.split("-")[0] },
      status: { name: "Done", statusCategory: { key: "done" } },
      resolution: { name: "Done" },
      created: "2026-02-01T09:00:00.000+0000",
      resolutiondate: "2026-02-10T17:30:00.000+0100",
    },
    changelog: { total, histories },
  };
}

const started = { created: "2026-02-03T10:00:00.000+0000", items: [{ field: "status", from: "1", to: "3", fromString: "To Do", toString: "In Progress" }] };
const assigned = { created: "2026-02-02T10:00:00.000+0000", items: [{ field: "assignee", fromString: null, toString: "Sam" }] };
const done = { created: "2026-02-10T16:30:00.000+0000", items: [{ field: "status", from: "3", to: "5", fromString: "In Progress", toString: "Done" }] };

describe("parseJiraDate", () => {
  it("accepts Jira's offset format and rejects junk", () => {
    assert.equal(parseJiraDate("2026-02-10T17:30:00.000+0100").toISOString(), "2026-02-10T16:30:00.000Z");
    assert.equal(parseJiraDate("2026-02-10T16:30:00.000+0000").toISOString(), "2026-02-10T16:30:00.000Z");
    assert.throws(() => parseJiraDate("yesterday"), /Not a valid Jira date/);
  });
});

describe("JiraClient.searchIssues", () => {
  it("pages with nextPageToken, sends the JQL and field list, and maps issues with ordered status transitions", async () => {
    const { fetch, jira } = client({
      "/rest/api/3/search/jql": (url) =>
        url.searchParams.get("nextPageToken") === "p2"
          ? { body: { issues: [rawIssue("GR-2", [done, started])], isLast: true, nextPageToken: null } }
          : { body: { issues: [rawIssue("GR-1", [done, assigned, started])], nextPageToken: "p2", isLast: false } },
    });

    const issues = await Array.fromAsync(jira.searchIssues("project = GR"));

    assert.deepEqual(issues.map((i) => i.key), ["GR-1", "GR-2"]);
    const first = issues[0]!;
    assert.equal(first.projectKey, "GR");
    assert.equal(first.type, "Story");
    assert.equal(first.statusCategory, "done");
    assert.equal(first.resolution, "Done");
    assert.equal(first.createdAt.toISOString(), "2026-02-01T09:00:00.000Z");
    assert.equal(first.resolvedAt?.toISOString(), "2026-02-10T16:30:00.000Z");
    assert.deepEqual(
      first.statusTransitions.map((t) => [t.at.toISOString(), t.fromStatusId, t.toStatusId, t.toStatus]),
      [
        ["2026-02-03T10:00:00.000Z", "1", "3", "In Progress"],
        ["2026-02-10T16:30:00.000Z", "3", "5", "Done"],
      ],
      "non-status changes dropped, oldest first",
    );

    const [req1, req2] = fetch.requests;
    assert.equal(req1?.searchParams.get("jql"), "project = GR");
    assert.equal(req1?.searchParams.get("expand"), "changelog");
    assert.match(req1?.searchParams.get("fields") ?? "", /resolutiondate/);
    assert.equal(req1?.searchParams.has("nextPageToken"), false);
    assert.equal(req2?.searchParams.get("nextPageToken"), "p2");
    assert.equal(fetch.requests.length, 2);
  });

  it("fetches the full changelog by offset when search truncated it", async () => {
    const { fetch, jira } = client({
      "/rest/api/3/search/jql": () => ({ body: { issues: [rawIssue("GR-7", [done], 3)], isLast: true } }),
      "/rest/api/3/issue/7/changelog": (url) =>
        url.searchParams.get("startAt") === "2"
          ? { body: { values: [done], isLast: true, startAt: 2, total: 3 } }
          : { body: { values: [assigned, started], isLast: false, startAt: 0, total: 3 } },
    });

    const [issue] = await Array.fromAsync(jira.searchIssues("key = GR-7"));

    assert.equal(issue?.statusTransitions.length, 2);
    const changelogRequests = fetch.requests.filter((u) => u.pathname.endsWith("/changelog"));
    assert.deepEqual(changelogRequests.map((u) => u.searchParams.get("startAt")), ["0", "2"]);
  });

  it("refuses to loop on a changelog page that claims more entries but returns none", async () => {
    const { jira } = client({
      "/rest/api/3/search/jql": () => ({ body: { issues: [rawIssue("GR-7", [done], 3)], isLast: true } }),
      "/rest/api/3/issue/7/changelog": () => ({ body: { values: [], isLast: false } }),
    });
    await assert.rejects(Array.fromAsync(jira.searchIssues("x")), /GR-7.*returned none/);
  });

  it("fails rather than silently stopping when a page says it is not last but has no token", async () => {
    const { jira } = client({ "/rest/api/3/search/jql": () => ({ body: { issues: [], isLast: false } }) });
    await assert.rejects(Array.fromAsync(jira.searchIssues("x")), /no nextPageToken/);
  });

  it("surfaces HTTP failures with a hint and the path", async () => {
    const { jira } = client({ "/rest/api/3/search/jql": () => ({ status: 401, body: { errorMessages: ["Unauthorized"] } }) });
    await assert.rejects(Array.fromAsync(jira.searchIssues("x")), /HTTP 401.*search\/jql.*ATLASSIAN_TOKEN/);
  });

  it("fails on an unexpected payload rather than yielding partial issues", async () => {
    const { jira } = client({ "/rest/api/3/search/jql": () => ({ body: { issues: [{ key: "GR-1" }] } }) });
    await assert.rejects(Array.fromAsync(jira.searchIssues("x")), /Unexpected Jira payload/);
  });

  it("names the path when a 200 response is not JSON, e.g. an SSO page", async () => {
    const { jira } = client({ "/rest/api/3/search/jql": () => ({ body: "<html>Sign in</html>" }) });
    await assert.rejects(Array.fromAsync(jira.searchIssues("x")), /non-JSON.*search\/jql.*<html>/);
  });
});

describe("JiraClient.listStatusCategories", () => {
  it("maps status ids to categories", async () => {
    const { jira } = client({
      "/rest/api/3/status": () => ({
        body: [
          { id: "1", name: "To Do", statusCategory: { key: "new" } },
          { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
          { id: "5", name: "Done", statusCategory: { key: "done" } },
        ],
      }),
    });
    assert.deepEqual([...(await jira.listStatusCategories())], [["1", "new"], ["3", "indeterminate"], ["5", "done"]]);
  });
});

describe("JiraClient.listLinkedPullRequests", () => {
  const INSTANCE = "oAuth-com.github.integration.production";
  const summaryWith = (byInstanceType: Record<string, { count: number; name?: string }>) => ({
    summary: { pullrequest: { overall: { count: 2 }, byInstanceType }, build: { overall: { count: 0 }, byInstanceType: {} } },
  });

  it("asks the summary which integration holds the PRs, then flattens that instance's detail", async () => {
    const { fetch, jira } = client({
      "/rest/dev-status/latest/issue/summary": () => ({ body: summaryWith({ [INSTANCE]: { count: 2, name: "GitHub" } }) }),
      "/rest/dev-status/latest/issue/detail": () => ({
        body: {
          detail: [
            {
              pullRequests: [
                { id: "#4193", name: "CW-394: Disposals", url: "https://github.com/kato-app/kato/pull/4193", status: "MERGED", lastUpdate: "2026-09-09T15:40:00.000+0000", source: { branch: "cw-394-disposals" } },
                { id: "#12", name: null, url: "https://github.com/kato-app/kato-settings/pull/12", status: "OPEN", lastUpdate: "2026-09-10T08:00:00.000+0000", source: { branch: null } },
              ],
            },
          ],
        },
      }),
    });

    const prs = await jira.listLinkedPullRequests("10001");

    assert.deepEqual(prs, [
      { url: "https://github.com/kato-app/kato/pull/4193", title: "CW-394: Disposals", status: "MERGED", sourceBranch: "cw-394-disposals", lastUpdate: new Date("2026-09-09T15:40:00.000Z") },
      { url: "https://github.com/kato-app/kato-settings/pull/12", title: null, status: "OPEN", sourceBranch: null, lastUpdate: new Date("2026-09-10T08:00:00.000Z") },
    ]);
    const [summaryReq, detailReq] = fetch.requests;
    assert.equal(summaryReq?.searchParams.get("issueId"), "10001");
    assert.equal(detailReq?.searchParams.get("issueId"), "10001");
    assert.equal(detailReq?.searchParams.get("applicationType"), INSTANCE, "detail must name the instance the summary reported");
    assert.equal(detailReq?.searchParams.get("dataType"), "pullrequest");
    assert.equal(fetch.requests.length, 2);
  });

  it("skips instances with a zero count and makes no detail call when nothing is linked", async () => {
    const { fetch, jira } = client({
      "/rest/dev-status/latest/issue/summary": () => ({ body: summaryWith({ [INSTANCE]: { count: 0 } }) }),
      "/rest/dev-status/latest/issue/detail": () => ({ status: 500, body: "should not be called" }),
    });
    assert.deepEqual(await jira.listLinkedPullRequests("1"), []);
    assert.equal(fetch.requests.length, 1);
  });

  it("tolerates a summary with no pullrequest section at all", async () => {
    const { jira } = client({ "/rest/dev-status/latest/issue/summary": () => ({ body: { summary: {} } }) });
    assert.deepEqual(await jira.listLinkedPullRequests("1"), []);
  });
});

describe("describeJiraError", () => {
  it("truncates long bodies and adds hints for the common statuses", () => {
    const err = describeJiraError(404, "/rest/api/3/x", "y".repeat(500));
    assert.match(err.message, /HTTP 404/);
    assert.match(err.message, /…/);
    assert.match(err.message, /ATLASSIAN_BASE_URL/);
    assert.doesNotMatch(describeJiraError(500, "/p", "boom").message, /Check/);
  });
});
