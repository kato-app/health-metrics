import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isHousekeepingPullRequest, parseReleaseNotes } from "../src/sources/github/release-notes.js";
import { parsePullRequestUrl } from "../src/sources/github/source.js";

const kato = { owner: "kato-app", name: "kato" };

const SAMPLE_BODY = `## What's Changed
* CW-394: Disposals index card shows rent figure when rent on application is selected by @kato-jm in https://github.com/kato-app/kato/pull/4193
* CW-305 Send 2FA Codes from dedicated Email Address by @kato-jm in https://github.com/kato-app/kato/pull/4183
* v77.9 by @kato-jm in https://github.com/kato-app/kato/pull/4202
- Awa 10288 kf availability schedule update rent field by @someone-else in https://github.com/kato-app/kato/pull/4162
* Not a pull request by @bot in https://github.com/kato-app/kato/commit/abc123


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
  it("returns each listed pull request once with its title, ignoring other links and the changelog footer", () => {
    assert.deepEqual(parseReleaseNotes(SAMPLE_BODY), [
      { ref: { repo: kato, number: 4193 }, title: "CW-394: Disposals index card shows rent figure when rent on application is selected", author: "kato-jm" },
      { ref: { repo: kato, number: 4183 }, title: "CW-305 Send 2FA Codes from dedicated Email Address", author: "kato-jm" },
      { ref: { repo: kato, number: 4202 }, title: "v77.9", author: "kato-jm" },
      { ref: { repo: kato, number: 4162 }, title: "Awa 10288 kf availability schedule update rent field", author: "someone-else" },
    ]);
  });

  it("handles empty, null and hand-written bodies", () => {
    assert.deepEqual(parseReleaseNotes(null), []);
    assert.deepEqual(parseReleaseNotes(""), []);
    assert.deepEqual(parseReleaseNotes("Bug fixes and performance improvements."), []);
  });

  it("de-duplicates a pull request listed twice, even under differently written URLs", () => {
    const body = ["* Same by @a in https://github.com/kato-app/kato/pull/1", "* Same again by @a in https://github.com/kato-app/kato/pull/1/files"].join("\n");
    assert.deepEqual(parseReleaseNotes(body), [{ ref: { repo: kato, number: 1 }, title: "Same", author: "a" }]);
  });
});

describe("isHousekeepingPullRequest", () => {
  it("recognises branch-sync and version-cut pull requests", () => {
    for (const title of ["Main to Release", "Release => Main  v77.10", "v77.9", "v77", "2.25.1", "Release v2.25.1", "Release 77", "release", "Merge pull request #555 from kato-app/main"]) {
      assert.ok(isHousekeepingPullRequest(title), title);
    }
  });

  it("leaves feature work, including titles that merely start with a version, to the unlinked log", () => {
    // "Jam.dev to main" is not a long-lived branch sync and stays in the unlinked log on purpose.
    for (const title of ["At 764 radius api floor name inference", "Hotfix for uuid migration", "Release notes page redesign", "Fix CI: update .ai submodule", "Jam.dev to main", "2 factor auth setup", "V2 endpoints for floors"]) {
      assert.equal(isHousekeepingPullRequest(title), false, title);
    }
  });
});
