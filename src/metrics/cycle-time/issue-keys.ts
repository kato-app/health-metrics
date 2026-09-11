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
  const projects = projectKeys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(`\\b(${projects})[-_ ]?(\\d{1,7})\\b`, "gi");

  const keys: string[] = [];
  for (const [, project, number] of text.matchAll(pattern)) {
    const key = `${project!.toUpperCase()}-${number}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}
