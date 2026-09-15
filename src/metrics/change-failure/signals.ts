import type { ReleaseRef } from "../cycle-time/release-index.js";

/** "Hotfix for uuid migration", "HOTFIX. Rightmove V2 validation", "hot fix loader", "awa-000-hotfix-loader". */
const HOTFIX_TITLE = /hot[\s-]?fix/i;
/** GitHub's default title for a revert: "Revert \"AT-764: ...\"". */
const REVERT_TITLE = /^\s*revert\b/i;

export function isHotfixTitle(title: string): boolean {
  return HOTFIX_TITLE.test(title);
}

export function isRevertTitle(title: string): boolean {
  return REVERT_TITLE.test(title);
}

/** A release tag made of dot-separated numbers, with or without a leading "v": `v73.36.1`, `2.25`, `v77`. */
export interface VersionTag {
  readonly parts: readonly number[];
}

export function parseVersionTag(tag: string): VersionTag | undefined {
  const match = /^v?(\d+(?:\.\d+)*)$/i.exec(tag.trim());
  return match ? { parts: match[1]!.split(".").map(Number) } : undefined;
}

/**
 * Whether the tag looks like a patch on an earlier version: three or more
 * components with a non-zero last one, e.g. `v73.36.1`. Two-component tags
 * (`v73.36`) are ordinary releases here, since that is how the teams cut them.
 */
export function isPatchTag(tag: string): boolean {
  const version = parseVersionTag(tag);
  return version !== undefined && version.parts.length >= 3 && version.parts.at(-1)! > 0;
}

/**
 * The release a patch tag patches: the latest earlier release of the same
 * repository whose version is the patch's prefix (`v73.36` for `v73.36.1`) or
 * a lower patch of it (`v73.36.1` for `v73.36.2`). Undefined when no such
 * release is indexed, e.g. because it predates the start date.
 */
export function findPatchBase(patch: ReleaseRef, earlierReleases: readonly ReleaseRef[]): ReleaseRef | undefined {
  const version = parseVersionTag(patch.tag);
  if (!version || !isPatchTag(patch.tag)) return undefined;
  const prefix = version.parts.slice(0, -1);
  const patchLevel = version.parts.at(-1)!;

  let best: { release: ReleaseRef; level: number } | undefined;
  for (const candidate of earlierReleases) {
    if (candidate.publishedAt >= patch.publishedAt) continue;
    const parts = parseVersionTag(candidate.tag)?.parts;
    if (!parts) continue;
    const samePrefix = parts.length >= prefix.length && prefix.every((n, i) => parts[i] === n);
    if (!samePrefix || parts.length > prefix.length + 1) continue;
    const level = parts.length === prefix.length ? 0 : parts[prefix.length]!;
    if (level >= patchLevel) continue;
    if (!best || level > best.level) best = { release: candidate, level };
  }
  return best?.release;
}
