import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractIssueKeys } from "../src/metrics/cycle-time/issue-keys.js";

const PROJECTS = ["AT", "CW", "GR"];

describe("extractIssueKeys", () => {
  it("matches strict keys in titles and branch names", () => {
    assert.deepEqual(extractIssueKeys("CW-394: Disposals index card", PROJECTS), ["CW-394"]);
    assert.deepEqual(extractIssueKeys("AT-764-radius-api-floor-name-inference", PROJECTS), ["AT-764"]);
  });

  it("tolerates GitHub's branch-derived titles: capitalised project, any separator or none", () => {
    assert.deepEqual(extractIssueKeys("At 764 radius api floor name inference", PROJECTS), ["AT-764"]);
    assert.deepEqual(extractIssueKeys("Gr_272 add knight frank users", PROJECTS), ["GR-272"]);
    assert.deepEqual(extractIssueKeys("Cw305 quick fix", PROJECTS), ["CW-305"]);
  });

  it("requires the first letter to be upper case so English words are not keys", () => {
    assert.deepEqual(extractIssueKeys("Retry at 3 seconds", PROJECTS), []);
    assert.deepEqual(extractIssueKeys("gr-272 lower case branch", PROJECTS), []);
  });

  it("ignores projects that are not configured", () => {
    assert.deepEqual(extractIssueKeys("Awa 10288 kf availability schedule", PROJECTS), []);
    assert.deepEqual(extractIssueKeys("AWA-10288 and CW-1", PROJECTS), ["CW-1"]);
  });

  it("does not match a project key inside another word or a bare number", () => {
    assert.deepEqual(extractIssueKeys("Format 123 dates", PROJECTS), []);
    assert.deepEqual(extractIssueKeys("Update GRep 42", PROJECTS), []);
    assert.deepEqual(extractIssueKeys("Main to Release", PROJECTS), []);
    assert.deepEqual(extractIssueKeys("CW- 12", PROJECTS), []);
  });

  it("returns unique keys in order of first appearance", () => {
    assert.deepEqual(extractIssueKeys("CW-1 and Cw-1 then AT-2 (CW-1)", PROJECTS), ["CW-1", "AT-2"]);
  });

  it("returns nothing when no projects are configured", () => {
    assert.deepEqual(extractIssueKeys("CW-1", []), []);
  });
});
