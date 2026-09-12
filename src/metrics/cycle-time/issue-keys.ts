/**
 * Finds Jira issue keys for the given projects in free text such as a pull
 * request title or branch name.
 *
 * Tolerant on purpose: GitHub derives PR titles from branch names, turning
 * `AWA-10288-fix` into "Awa 10288 fix", so the match is case-insensitive and
 * accepts `-`, `_`, a space, or nothing between project and number. Word
 * boundaries stop "Format 123" matching project AT. Results are normalised to
 * `KEY-123`, unique, in order of first appearance.
 */
export function extractIssueKeys(text: string, projectKeys: readonly string[]): string[] {
  if (projectKeys.length === 0) return [];
  // Keys come from config.json, so escape rather than trust them to be plain letters.
  const projects = projectKeys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(String.raw`\b(${projects})[-_ ]?(\d{1,7})\b`, "gi");
  const keys = Array.from(text.matchAll(pattern), ([, project, number]) => `${project!.toUpperCase()}-${number}`);
  return [...new Set(keys)];
}
