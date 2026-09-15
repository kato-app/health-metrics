import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noopLogger } from "../src/logging/logger.js";
import { findRemediations } from "../src/metrics/change-failure/remediations.js";
import { findPatchBase, isHotfixTitle, isPatchTag, isRevertTitle, parseVersionTag } from "../src/metrics/change-failure/signals.js";
import { ReleaseTimeline, releaseKey } from "../src/metrics/change-failure/timeline.js";
import { buildReleaseIndex, type ReleaseRef } from "../src/metrics/cycle-time/release-index.js";
import { FakeGitHubSource, FakeJiraSource, jiraIssueSummary, linkedPullRequest, release } from "./helpers/fakes.js";

const kato = { owner: "kato-app", name: "kato" };
const settings = { owner: "kato-app", name: "kato-settings" };
const ref = (repo: typeof kato, tag: string, publishedAt: string): ReleaseRef => ({ repo, tag, name: null, publishedAt: new Date(publishedAt) });

describe("signals", () => {
  it("recognises hotfix and revert titles", () => {
    for (const t of ["Hotfix for uuid migration", "HOTFIX. Rightmove V2 validation. TO RELEASE", "hot fix loader", "Hot-Fix loader", "awa-00000-hotfix-loader-example-file", "AT-635: Hotfix showing kato signals"]) {
      assert.ok(isHotfixTitle(t), t);
    }
    assert.equal(isHotfixTitle("Fix hot path performance"), false);
    assert.equal(isHotfixTitle("Snapshot fix for the dashboard"), false, "hot must start a word");
    assert.ok(isRevertTitle('Revert "AT-764: radius api"'));
    assert.equal(isRevertTitle("Do not revert this"), false);
  });

  it("parses version tags and identifies patch tags", () => {
    assert.deepEqual(parseVersionTag("v73.36.1"), [73, 36, 1]);
    assert.deepEqual(parseVersionTag("2.25"), [2, 25]);
    assert.equal(parseVersionTag("s5"), undefined);
    assert.equal(parseVersionTag("kato v76.3"), undefined);
    assert.ok(isPatchTag("v73.36.1"));
    assert.ok(isPatchTag("v2.25.1"));
    assert.equal(isPatchTag("v73.36"), false, "two components are ordinary releases");
    assert.equal(isPatchTag("v73.36.0"), false);
    assert.equal(isPatchTag("s5"), false);
  });

  it("finds the base of a patch tag: the prefix version or the highest lower patch, published earlier", () => {
    const earlier = [
      ref(kato, "v73.35", "2026-03-01T10:00:00Z"),
      ref(kato, "v73.36", "2026-03-02T10:00:00Z"),
      ref(kato, "v73.36.1", "2026-03-03T10:00:00Z"),
      ref(kato, "v73.36.1.1", "2026-03-04T09:00:00Z"),
      ref(kato, "v73.37", "2026-03-05T10:00:00Z"),
    ];
    assert.equal(findPatchBase(ref(kato, "v73.36.1", "2026-03-03T10:00:00Z"), earlier)?.tag, "v73.36");
    assert.equal(findPatchBase(ref(kato, "v73.36.2", "2026-03-04T10:00:00Z"), earlier)?.tag, "v73.36.1", "a deeper tag like v73.36.1.1 is not a sibling patch");
    assert.equal(findPatchBase(ref(kato, "v73.38.1", "2026-03-06T10:00:00Z"), earlier), undefined, "base not indexed");
    assert.equal(findPatchBase(ref(kato, "v73.37", "2026-03-05T10:00:00Z"), earlier), undefined, "not a patch tag");
  });
});

describe("ReleaseTimeline", () => {
  const timeline = new ReleaseTimeline([
    ref(kato, "v2", "2026-02-01T10:00:00Z"),
    ref(settings, "s1", "2026-02-03T10:00:00Z"),
    ref(kato, "v1", "2026-01-15T10:00:00Z"),
    ref(kato, "v3", "2026-03-01T10:00:00Z"),
  ]);

  it("orders per repository and answers live-at and previous lookups", () => {
    assert.deepEqual(timeline.releasesOf(kato).map((r) => r.tag), ["v1", "v2", "v3"]);
    assert.equal(timeline.liveAt(kato, new Date("2026-02-15T00:00:00Z"))?.tag, "v2");
    assert.equal(timeline.liveAt(kato, new Date("2026-02-01T10:00:00Z"))?.tag, "v2", "inclusive of the publish instant");
    assert.equal(timeline.liveAt(kato, new Date("2026-01-01T00:00:00Z")), undefined);
    assert.equal(timeline.previous(ref(kato, "v3", "2026-03-01T10:00:00Z"))?.tag, "v2");
    assert.equal(timeline.previous(ref(kato, "v1", "2026-01-15T10:00:00Z")), undefined);
    assert.equal(releaseKey(ref(settings, "s1", "2026-02-03T10:00:00Z")), "kato-app/kato-settings@s1");
  });
});

describe("findRemediations", () => {
  const note = (repo: string, n: number, title: string, by = "kato-jm") => `* ${title} by @${by} in https://github.com/kato-app/${repo}/pull/${n}`;
  const options = { projectKeys: ["GR", "CW"], startDate: new Date("2026-01-01T00:00:00Z"), keylessAttributionDays: 3, regressionLabel: "regression" };

  /**
   * kato timeline: v70 (Feb 1) -> v71 (Feb 10) -> v71.0.1 patch with a keyed hotfix (Feb 12)
   *                -> v72.0 (Mar 1) -> v73.0 with a key-less hotfix (Mar 2) -> v74.0 with a revert, 10 days later (Mar 12)
   * kato-settings: s1 (Feb 5) -> s2 (Feb 20) with a hotfix naming a key Jira does not know.
   */
  function github() {
    return new FakeGitHubSource({
      kato: [
        release({ id: 74, tag_name: "v74.0", published_at: "2026-03-12T10:00:00Z", body: note("kato", 740, 'Revert "GR-5 experiment"') }),
        release({ id: 73, tag_name: "v73.0", published_at: "2026-03-02T10:00:00Z", body: note("kato", 730, "Hotfix broken login", "sam") }),
        release({ id: 72, tag_name: "v72.0", published_at: "2026-03-01T10:00:00Z", body: note("kato", 720, "GR-7 feature") }),
        release({ id: 711, tag_name: "v71.0.1", published_at: "2026-02-12T10:00:00Z", body: note("kato", 711, "GR-9: Hotfix null pointer") }),
        release({ id: 71, tag_name: "v71.0", published_at: "2026-02-10T10:00:00Z", body: note("kato", 710, "GR-8 feature") }),
        release({ id: 70, tag_name: "v70.0", published_at: "2026-02-01T10:00:00Z", body: note("kato", 700, "GR-6 feature") }),
      ],
      "kato-settings": [
        release({ id: 2, tag_name: "s2", published_at: "2026-02-20T10:00:00Z", body: note("kato-settings", 20, "GR-999 hotfix settings", "jo") }),
        release({ id: 1, tag_name: "s1", published_at: "2026-02-05T10:00:00Z", body: note("kato-settings", 10, "GR-3 feature") }),
      ],
    });
  }

  it("attributes each remediation in order of trust and reports the rest as unclaimed", async () => {
    // GR-9 (the keyed hotfix) was raised while v70.0 was live; GR-210 is a labelled regression fixed by kato#720 in v72.0.
    const jira = new FakeJiraSource([], { "210": [linkedPullRequest("https://github.com/kato-app/kato/pull/720")] }, undefined, [], [
      jiraIssueSummary({ key: "GR-9", createdAt: new Date("2026-02-05T09:00:00Z") }),
      jiraIssueSummary({ key: "GR-210", createdAt: new Date("2026-02-11T09:00:00Z"), labels: ["regression"] }),
    ]);
    const index = await buildReleaseIndex(github(), [kato, settings], options.startDate, noopLogger);

    const report = await findRemediations(index, jira, [kato, settings], options, noopLogger);

    const summary = [...report.byRelease.entries()].map(([key, list]) => [key, list.map((r) => `${r.signal}:${r.evidence}`)]).sort();
    assert.deepEqual(summary, [
      ["kato-app/kato@v70.0", ["hotfix:kato-app/kato#711 \"GR-9: Hotfix null pointer\""]],
      ["kato-app/kato@v71.0", ["patch_tag:v71.0.1", "jira_regression:GR-210"]],
      ["kato-app/kato@v72.0", ["hotfix:kato-app/kato#730 \"Hotfix broken login\""]],
    ]);
    assert.equal(report.byRelease.get("kato-app/kato@v71.0")?.find((r) => r.signal === "jira_regression")?.remediatedBy?.tag, "v72.0");
    assert.deepEqual(
      report.unclaimed.map((u) => [u.signal, u.release.tag, u.author, u.reason]),
      [
        ["revert", "v74.0", "kato-jm", "no issue key, and the previous release v73.0 is 10.0 days older than the 3-day limit"],
        ["hotfix", "s2", "jo", "no issue key, and the previous release s1 is 15.0 days older than the 3-day limit"],
      ],
    );
    assert.deepEqual(report.regressionBugsWithoutPullRequest, []);
    assert.match(jira.queries[0]!, /issuetype = Bug AND created >= "2026-01-01" AND \(labels = "regression" OR affectedVersion is not EMPTY\)/);
  });

  it("does not pin a keyed hotfix on a release published after the bug was raised, and lists regression bugs without a pull request", async () => {
    const jira = new FakeJiraSource([], {}, undefined, [], [
      jiraIssueSummary({ key: "GR-9", createdAt: new Date("2026-02-12T12:00:00Z") }), // after v71.0.1 shipped
      jiraIssueSummary({ key: "GR-300", createdAt: new Date("2026-02-11T09:00:00Z"), affectsVersions: ["v71.0"] }),
    ]);
    const index = await buildReleaseIndex(github(), [kato], options.startDate, noopLogger);

    const report = await findRemediations(index, jira, [kato], options, noopLogger);

    assert.ok(report.unclaimed.some((u) => u.evidence.includes("#711") && u.reason.includes("created after the fixing release v71.0.1")));
    assert.deepEqual(report.regressionBugsWithoutPullRequest, ["GR-300"]);
  });

  it("reports a patch tag whose base is not indexed as unclaimed", async () => {
    const gh = new FakeGitHubSource({ kato: [release({ id: 1, tag_name: "v69.4.1", published_at: "2026-01-10T10:00:00Z", body: note("kato", 1, "GR-1 fix") })] });
    const index = await buildReleaseIndex(gh, [kato], options.startDate, noopLogger);

    const report = await findRemediations(index, new FakeJiraSource([]), [kato], options, noopLogger);

    assert.deepEqual(report.unclaimed.map((u) => [u.signal, u.evidence]), [["patch_tag", "v69.4.1"]]);
    assert.equal(report.byRelease.size, 0);
  });
});

describe("findPatchBase with major-only base tags", () => {
  it("treats v68 as the base of v68.0.1, and v68.0.1 as the base of v68.0.2", () => {
    const earlier = [ref(kato, "v67", "2026-01-20T10:00:00Z"), ref(kato, "v68", "2026-02-01T10:00:00Z"), ref(kato, "v68.0.1", "2026-02-02T10:00:00Z"), ref(kato, "v68.1", "2026-02-05T10:00:00Z")];
    assert.equal(findPatchBase(ref(kato, "v68.0.1", "2026-02-02T10:00:00Z"), earlier)?.tag, "v68");
    assert.equal(findPatchBase(ref(kato, "v68.0.2", "2026-02-03T10:00:00Z"), earlier)?.tag, "v68.0.1");
    assert.equal(findPatchBase(ref(kato, "v68.1.1", "2026-02-06T10:00:00Z"), earlier)?.tag, "v68.1");
    assert.equal(findPatchBase(ref(kato, "v69.0.1", "2026-02-07T10:00:00Z"), earlier), undefined, "v69 never released");
  });
});
