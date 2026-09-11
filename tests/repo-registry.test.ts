import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LogContext, Logger } from "../src/logging/logger.js";
import { noopLogger } from "../src/logging/logger.js";
import { createRepoRegistry } from "../src/sources/github/repo-registry.js";
import { FakeGitHubSource, release } from "./helpers/fakes.js";

/** Captures warn calls so a test can assert on them. */
function warnRecorder(): Logger & { warnings: { message: string; context?: LogContext }[] } {
  const warnings: { message: string; context?: LogContext }[] = [];
  const logger: Logger = {
    ...noopLogger,
    warn: (message, context) => void warnings.push(context ? { message, context } : { message }),
    child: () => logger,
  };
  return Object.assign(logger, { warnings });
}

const github = () =>
  new FakeGitHubSource({
    kato: [release({ id: 1 })],
    docs: [],
    "kato-settings": [release({ id: 2 })],
    portal: [release({ id: 3 })],
  });

describe("createRepoRegistry", () => {
  it("returns every discovered repo as owner/name refs, in discovery order", async () => {
    const registry = createRepoRegistry({ github: github(), owner: "kato-app", excludeRepos: [], logger: noopLogger });

    assert.deepEqual(await registry.list(), [
      { owner: "kato-app", name: "kato" },
      { owner: "kato-app", name: "kato-settings" },
      { owner: "kato-app", name: "portal" },
    ]);
  });

  it("drops excluded repos even though they have releases", async () => {
    const registry = createRepoRegistry({ github: github(), owner: "kato-app", excludeRepos: ["portal"], logger: noopLogger });

    assert.deepEqual(
      (await registry.list()).map((r) => r.name),
      ["kato", "kato-settings"],
    );
  });

  it("warns about an exclusion that matches nothing, since it is probably a typo", async () => {
    const logger = warnRecorder();
    const registry = createRepoRegistry({ github: github(), owner: "kato-app", excludeRepos: ["portla"], logger });

    await registry.list();

    assert.equal(logger.warnings.length, 1);
    assert.deepEqual(logger.warnings[0]?.context, { excludeRepos: ["portla"] });
  });

  it("runs discovery once no matter how many metrics ask", async () => {
    const source = github();
    const registry = createRepoRegistry({ github: source, owner: "kato-app", excludeRepos: [], logger: noopLogger });

    await Promise.all([registry.list(), registry.list()]);
    await registry.list();

    assert.equal(source.discoveryCalls, 1);
  });

  it("propagates a discovery failure to every caller instead of falling back", async () => {
    const source = github();
    source.listReposWithReleases = async () => {
      throw new Error("Bad credentials");
    };
    const registry = createRepoRegistry({ github: source, owner: "kato-app", excludeRepos: [], logger: noopLogger });

    await assert.rejects(registry.list(), /Bad credentials/);
    await assert.rejects(registry.list(), /Bad credentials/);
  });
});
