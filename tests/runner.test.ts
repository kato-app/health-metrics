import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runMetric, runMetrics } from "../src/core/runner.js";
import { noopLogger } from "../src/logging/logger.js";
import { InMemorySink, fakeMetric } from "./helpers/fakes.js";

const columns = ["published_at", "id"] as const;

describe("runMetric", () => {
  it("passes existing rows to collect and appends what comes back", async () => {
    const sink = new InMemorySink();
    sink.seed("m", [{ published_at: "2026-01-01 00:00:00", id: 1 }]);
    let seen: readonly unknown[] = [];
    const metric = fakeMetric("m", columns, async (ctx) => {
      seen = ctx.existingRows;
      return [{ published_at: "2026-01-02 00:00:00", id: 2 }];
    });

    const result = await runMetric(metric, { sink, logger: noopLogger, dryRun: false });

    assert.deepEqual(result, { metric: "m", status: "ok", rowsCollected: 1, rowsWritten: 1 });
    assert.equal(seen.length, 1);
    assert.equal(sink.tabs.get("m")?.length, 2);
  });

  it("does not write in dry-run mode", async () => {
    const sink = new InMemorySink();
    const metric = fakeMetric("m", columns, async () => [{ published_at: "x", id: 1 }]);

    const result = await runMetric(metric, { sink, logger: noopLogger, dryRun: true });

    assert.deepEqual(result, { metric: "m", status: "ok", rowsCollected: 1, rowsWritten: 0 });
    assert.equal(sink.appendCalls.length, 0);
  });

  it("skips the sink call when there is nothing new", async () => {
    const sink = new InMemorySink();
    const metric = fakeMetric("m", columns, async () => []);

    await runMetric(metric, { sink, logger: noopLogger, dryRun: false });

    assert.equal(sink.appendCalls.length, 0);
  });

  it("rejects rows that do not match the metric's columns", async () => {
    const sink = new InMemorySink();
    const metric = fakeMetric("m", columns, async () => [{ published_at: "x", wrong: 1 }]);

    const result = await runMetric(metric, { sink, logger: noopLogger, dryRun: false });

    assert(result.status === "failed");
    assert(result.error instanceof Error);
    assert.match(result.error.message, /missing: id.*unexpected: wrong/);
    assert.equal(sink.appendCalls.length, 0);
  });

  it("returns a failed result instead of throwing when collect rejects", async () => {
    const sink = new InMemorySink();
    const metric = fakeMetric("m", columns, async () => {
      throw new Error("boom");
    });

    const result = await runMetric(metric, { sink, logger: noopLogger, dryRun: false });

    assert.equal(result.status, "failed");
  });
});

describe("runMetrics", () => {
  it("runs every metric even when an earlier one fails", async () => {
    const sink = new InMemorySink();
    const failing = fakeMetric("a", columns, async () => {
      throw new Error("boom");
    });
    const ok = fakeMetric("b", columns, async () => [{ published_at: "x", id: 1 }]);

    const results = await runMetrics([failing, ok], { sink, logger: noopLogger, dryRun: false });

    assert.deepEqual(
      results.map((r) => [r.metric, r.status]),
      [
        ["a", "failed"],
        ["b", "ok"],
      ],
    );
    assert.equal(sink.tabs.get("b")?.length, 1);
  });
});
