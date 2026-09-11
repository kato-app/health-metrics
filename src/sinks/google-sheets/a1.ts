/** A1-notation helpers for the column block a metric owns, which always starts at column A. */

/** Zero-based column index to letters: 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let letters = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) letters = String.fromCharCode(65 + (n % 26)) + letters;
  return letters;
}

/** Whole-column range for the first `count` columns, e.g. `A:H`. */
export function columnsRange(count: number): string {
  return `A:${columnLetter(count - 1)}`;
}

/** The header cells of the first `count` columns, e.g. `A1:H1`. */
export function headerRange(count: number): string {
  return `A1:${columnLetter(count - 1)}1`;
}
