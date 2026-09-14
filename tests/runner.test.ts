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

    const result = await runMetric(metric, { sink, logger: noopLogger, dryRun: false, full: false });

    assert.deepEqual(result, { metric: "m", status: "ok", rowsCollected: 1, rowsWritten: 1 });
    assert.equal(seen.length, 1);
    assert.equal(sink.tabs.get("m")?.length, 2);
  });

  it("does not write in dry-run mode", async () => {
    const sink = new InMemorySink();
    const metric = fakeMetric("m", columns, async () => [{ published_at: "x", id: 1 }]);

    const result = await runMetric(metric, { sink, logger: noopLogger, dryRun: true, full: false });

    assert.deepEqual(result, { metric: "m", status: "ok", rowsCollected: 1, rowsWritten: 0 });
    assert.equal(sink.appendCalls.length, 0);
  });

  it("skips the sink call when there is nothing new", async () => {
    const sink = new InMemorySink();
    const metric = fakeMetric("m", columns, async () => []);

    await runMetric(metric, { sink, logger: noopLogger, dryRun: false, full: false });

    assert.equal(sink.appendCalls.length, 0);
  });

  it("rejects rows that do not match the metric's columns", async () => {
    const sink = new InMemorySink();
    const metric = fakeMetric("m", columns, async () => [{ published_at: "x", wrong: 1 }]);

    const result = await runMetric(metric, { sink, logger: noopLogger, dryRun: false, full: false });

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

    const result = await runMetric(metric, { sink, logger: noopLogger, dryRun: false, full: false });

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

    const results = await runMetrics([failing, ok], { sink, logger: noopLogger, dryRun: false, full: false });

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

describe("runMetric with snapshot metrics and --full", () => {
  it("replaces the tab contents for a snapshot metric without reading existing rows, even when empty", async () => {
    const sink = new InMemorySink();
    sink.seed("s", [{ published_at: "2026-01-01 00:00:00", id: 1 }]);
    let seenExisting: readonly unknown[] | undefined;
    const snapshot = { ...fakeMetric("s", columns, async (ctx) => {
      seenExisting = ctx.existingRows;
      return [];
    }), mode: "snapshot" as const };

    const result = await runMetric(snapshot, { sink, logger: noopLogger, dryRun: false, full: false });

    assert.deepEqual(result, { metric: "s", status: "ok", rowsCollected: 0, rowsWritten: 0 });
    assert.deepEqual(seenExisting, [], "snapshot metrics never see existing rows");
    assert.deepEqual(sink.replaceCalls, [{ metric: "s", rows: [] }]);
    assert.deepEqual(sink.tabs.get("s"), [], "an empty snapshot empties the tab");
    assert.equal(sink.appendCalls.length, 0);
  });

  it("does not replace anything in a dry run", async () => {
    const sink = new InMemorySink();
    sink.seed("s", [{ published_at: "x", id: 1 }]);
    const snapshot = { ...fakeMetric("s", columns, async () => [{ published_at: "y", id: 2 }]), mode: "snapshot" as const };

    const result = await runMetric(snapshot, { sink, logger: noopLogger, dryRun: true, full: false });

    assert.deepEqual(result, { metric: "s", status: "ok", rowsCollected: 1, rowsWritten: 0 });
    assert.equal(sink.replaceCalls.length, 0);
    assert.equal(sink.tabs.get("s")?.length, 1);
  });

  it("passes the full flag through to collect", async () => {
    const sink = new InMemorySink();
    let seenFull: boolean | undefined;
    const metric = fakeMetric("m", columns, async (ctx) => {
      seenFull = ctx.full;
      return [];
    });

    await runMetric(metric, { sink, logger: noopLogger, dryRun: false, full: true });

    assert.equal(seenFull, true);
  });
});
