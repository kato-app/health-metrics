/**
 * Finds Jira issue keys for the given projects in free text such as a pull
 * request title or branch name.
 *
 * Tolerant on purpose: GitHub derives PR titles from branch names, turning
 * `AWA-10288-fix` into "Awa 10288 fix", so `-`, `_`, a space, or nothing may
 * separate project and number, and the letters after the first may be any
 * case. The first letter must be upper case: GitHub capitalises derived titles,
 * and requiring it stops the English word "at" in "Retry at 3 seconds" from
 * reading as AT-3. Word boundaries stop "Format 123" matching project AT.
 * Results are normalised to `KEY-123`, unique, in order of first appearance.
 */
export function extractIssueKeys(text: string, projectKeys: readonly string[]): string[] {
  if (projectKeys.length === 0) return [];
  const pattern = new RegExp(String.raw`\b(${projectKeys.map(projectPattern).join("|")})[-_ ]?(\d{1,7})\b`, "g");
  const keys = Array.from(text.matchAll(pattern), ([, project, number]) => `${project!.toUpperCase()}-${number}`);
  return [...new Set(keys)];
}

/** `AWA` → `A[Ww][Aa]`: exact first letter, either case for the rest. Keys come from config.json, so escape them. */
function projectPattern(key: string): string {
  const upper = key.toUpperCase();
  return [...upper]
    .map((ch, i) => {
      if (!/[A-Z]/.test(ch)) return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return i === 0 ? ch : `[${ch}${ch.toLowerCase()}]`;
    })
    .join("");
}

/**
 * Whether `text` (a branch name or title) names this exact issue, e.g.
 * `AWA-9892`, `awa-9892-fix-thing` or `Awa 9892 fix`, but not `AWA-98921` or
 * `XAWA-9892`. Unlike `extractIssueKeys` the match is fully case-insensitive:
 * the key is known, so no English word can be mistaken for a project. Keys
 * come from Jira as `PROJECT-123` (word characters only, so nothing to escape);
 * any other shape matches nothing.
 */
export function mentionsIssueKey(text: string, issueKey: string): boolean {
  const key = /^(\w+)-(\d+)$/.exec(issueKey);
  if (!key) return false;
  return new RegExp(String.raw`(?<![A-Za-z0-9])${key[1]}[-_ ]?${key[2]}(?!\d)`, "i").test(text);
}
