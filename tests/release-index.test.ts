import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noopLogger } from "../src/logging/logger.js";
import { buildReleaseIndex } from "../src/metrics/cycle-time/release-index.js";
import { isHousekeepingPullRequest, parseReleaseNotes } from "../src/sources/github/release-notes.js";
import { parsePullRequestUrl, pullRequestKey } from "../src/sources/github/source.js";
import { FakeGitHubSource, release } from "./helpers/fakes.js";

const kato = { owner: "kato-app", name: "kato" };
const settings = { owner: "kato-app", name: "kato-settings" };

const SAMPLE_BODY = `## What's Changed
* CW-394: Disposals index card shows rent figure when rent on application is selected by @kato-jm in https://github.com/kato-app/kato/pull/4193
* CW-305 Send 2FA Codes from dedicated Email Address by @kato-jm in https://github.com/kato-app/kato/pull/4183
* v77.9 by @kato-jm in https://github.com/kato-app/kato/pull/4202
- Awa 10288 kf availability schedule update rent field by @someone-else in https://github.com/kato-app/kato/pull/4162


**Full Changelog**: https://github.com/kato-app/kato/compare/v77.8...v77.9`;

describe("parsePullRequestUrl", () => {
  it("extracts owner, repo and number and rejects other GitHub URLs", () => {
    assert.deepEqual(parsePullRequestUrl("https://github.com/kato-app/kato/pull/4193"), { repo: kato, number: 4193 });
    assert.deepEqual(parsePullRequestUrl("https://github.com/kato-app/kato/pull/4193/files#diff"), { repo: kato, number: 4193 });
    assert.equal(parsePullRequestUrl("https://github.com/kato-app/kato/releases/tag/v1"), undefined);
    assert.equal(parsePullRequestUrl("https://github.com/kato-app/kato/pull/abc"), undefined);
  });
});

describe("parseReleaseNotes", () => {
  it("returns each listed pull request once with its title, ignoring the changelog footer", () => {
    assert.deepEqual(parseReleaseNotes(SAMPLE_BODY), [
      { ref: { repo: kato, number: 4193 }, title: "CW-394: Disposals index card shows rent figure when rent on application is selected" },
      { ref: { repo: kato, number: 4183 }, title: "CW-305 Send 2FA Codes from dedicated Email Address" },
      { ref: { repo: kato, number: 4202 }, title: "v77.9" },
      { ref: { repo: kato, number: 4162 }, title: "Awa 10288 kf availability schedule update rent field" },
    ]);
  });

  it("handles empty, null and hand-written bodies", () => {
    assert.deepEqual(parseReleaseNotes(null), []);
    assert.deepEqual(parseReleaseNotes(""), []);
    assert.deepEqual(parseReleaseNotes("Bug fixes and performance improvements."), []);
  });

  it("de-duplicates a pull request listed twice", () => {
    const line = "* Same by @a in https://github.com/kato-app/kato/pull/1";
    assert.equal(parseReleaseNotes(`${line}\n${line}`).length, 1);
  });
});

describe("isHousekeepingPullRequest", () => {
  it("recognises branch-sync and version-cut pull requests but not feature work", () => {
    for (const title of ["Main to Release", "Release => Main  v77.10", "v77.9", "v77", "2.25.1", "Release v2.25.1", "release", "Merge pull request #555 from kato-app/main"]) {
      assert.ok(isHousekeepingPullRequest(title), title);
    }
    // "Jam.dev to main" is not a long-lived branch sync and stays in the unlinked log on purpose.
    for (const title of ["At 764 radius api floor name inference", "Hotfix for uuid migration", "Release notes page redesign", "Fix CI: update .ai submodule", "Jam.dev to main", "2 factor auth setup"]) {
      assert.equal(isHousekeepingPullRequest(title), false, title);
    }
  });
});

describe("buildReleaseIndex", () => {
  const since = new Date("2026-01-01T00:00:00Z");
  const note = (repo: string, n: number, title: string) => `* ${title} by @x in https://github.com/kato-app/${repo}/pull/${n}`;

  it("maps each pull request to the earliest published release that lists it, across repos", async () => {
    const github = new FakeGitHubSource({
      kato: [
        release({ id: 3, tag_name: "v3", published_at: "2026-03-01T10:00:00Z", body: [note("kato", 30, "CW-3 thing"), note("kato", 20, "CW-2 again")].join("\n") }),
        release({ id: 2, tag_name: "v2", published_at: "2026-02-01T10:00:00Z", body: note("kato", 20, "CW-2 thing") }),
        release({ id: 1, tag_name: "v1", published_at: "2025-12-15T10:00:00Z", body: note("kato", 10, "CW-1 old") }),
      ],
      "kato-settings": [release({ id: 5, tag_name: "s5", published_at: "2026-02-15T10:00:00Z", body: note("kato-settings", 7, "GR-7 settings") })],
    });

    const index = await buildReleaseIndex(github, [kato, settings], since, noopLogger);

    assert.deepEqual(index.releaseFor({ repo: kato, number: 20 }), { repo: kato, tag: "v2", publishedAt: new Date("2026-02-01T10:00:00Z") });
    assert.equal(index.releaseFor({ repo: kato, number: 30 })?.tag, "v3");
    assert.equal(index.releaseFor({ repo: settings, number: 7 })?.tag, "s5");
    assert.equal(index.releaseFor({ repo: kato, number: 10 }), undefined, "release before `since` is not indexed");
    assert.equal(index.releaseFor({ repo: kato, number: 99 }), undefined);
    assert.deepEqual(index.shipped.map((s) => pullRequestKey(s.ref)).sort(), ["kato-app/kato#20", "kato-app/kato#30", "kato-app/kato-settings#7"]);
    assert.equal(github.yielded.get("kato"), 3, "stops paging at the first release created before `since`");
  });

  it("ignores drafts, prereleases and releases without notes", async () => {
    const github = new FakeGitHubSource({
      kato: [
        release({ id: 4, draft: true, published_at: null, body: note("kato", 40, "CW-4 draft") }),
        release({ id: 3, prerelease: true, published_at: "2026-03-01T10:00:00Z", body: note("kato", 30, "CW-3 pre") }),
        release({ id: 2, published_at: "2026-02-01T10:00:00Z", body: null }),
      ],
    });

    const index = await buildReleaseIndex(github, [kato], since, noopLogger);

    assert.deepEqual(index.shipped, []);
    assert.equal(index.releaseFor({ repo: kato, number: 30 }), undefined);
  });
});
