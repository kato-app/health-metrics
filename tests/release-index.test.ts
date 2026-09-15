import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noopLogger } from "../src/logging/logger.js";
import { buildReleaseIndex } from "../src/metrics/cycle-time/release-index.js";
import { pullRequestKey } from "../src/sources/github/source.js";
import { FakeGitHubSource, release } from "./helpers/fakes.js";

const kato = { owner: "kato-app", name: "kato" };
const settings = { owner: "kato-app", name: "kato-settings" };

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

    assert.deepEqual(index.releaseFor({ repo: kato, number: 20 }), { repo: kato, tag: "v2", name: "v2", publishedAt: new Date("2026-02-01T10:00:00Z") });
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
