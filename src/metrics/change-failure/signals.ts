import type { ReleaseRef } from "../cycle-time/release-index.js";

/**
 * "Hotfix for uuid migration", "HOTFIX. Rightmove V2 validation", "hot fix loader",
 * "awa-000-hotfix-loader", "Hotfixes". The leading boundary keeps "Snapshot fix" out.
 */
const HOTFIX_TITLE = /\bhot[\s-]?fix/i;
/** GitHub's default title for a revert: "Revert \"AT-764: ...\"". */
const REVERT_TITLE = /^\s*revert\b/i;

export function isHotfixTitle(title: string): boolean {
  return HOTFIX_TITLE.test(title);
}

export function isRevertTitle(title: string): boolean {
  return REVERT_TITLE.test(title);
}

/** The numeric components of a tag like `v73.36.1`, `2.25` or `v77`; undefined for anything else (`s5`, `kato v76.3`). */
export function parseVersionTag(tag: string): readonly number[] | undefined {
  const match = /^v?(\d+(?:\.\d+)*)$/i.exec(tag.trim());
  return match ? match[1]!.split(".").map(Number) : undefined;
}

/**
 * Whether the tag looks like a patch on an earlier version: three or more
 * components with a non-zero last one, e.g. `v73.36.1`. Two-component tags
 * (`v73.36`) are ordinary releases here, since that is how the teams cut them.
 */
export function isPatchTag(tag: string): boolean {
  const parts = parseVersionTag(tag);
  return parts !== undefined && isPatch(parts);
}

function isPatch(parts: readonly number[]): boolean {
  return parts.length >= 3 && parts.at(-1)! > 0;
}

/**
 * The release a patch tag patches: the latest earlier release of the same
 * repository whose version is the patch's prefix (`v73.36` for `v73.36.1`) or
 * a lower patch of it (`v73.36.1` for `v73.36.2`). Undefined when no such
 * release is indexed, e.g. because it predates the start date.
 */
export function findPatchBase(patch: ReleaseRef, earlierReleases: readonly ReleaseRef[]): ReleaseRef | undefined {
  const parts = parseVersionTag(patch.tag);
  if (!parts || !isPatch(parts)) return undefined;
  const base = parts.slice(0, -1);
  const level = parts.at(-1)!;

  let best: { release: ReleaseRef; level: number } | undefined;
  for (const candidate of earlierReleases) {
    if (candidate.publishedAt >= patch.publishedAt) continue;
    const candidateLevel = patchLevel(base, candidate.tag);
    if (candidateLevel === undefined || candidateLevel >= level) continue;
    if (!best || candidateLevel > best.level) best = { release: candidate, level: candidateLevel };
  }
  return best?.release;
}

/** Where `tag` sits on `base`: `v73.36` and `v73.36.0` are level 0 of [73, 36], `v73.36.2` is level 2; undefined for any other tag. */
function patchLevel(base: readonly number[], tag: string): number | undefined {
  const parts = parseVersionTag(tag);
  if (!parts || parts.length < base.length || parts.length > base.length + 1) return undefined;
  if (!base.every((n, i) => parts[i] === n)) return undefined;
  return parts[base.length] ?? 0;
}
