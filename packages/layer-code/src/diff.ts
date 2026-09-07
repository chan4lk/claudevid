// Pure LCS line diff (spec.md FR11). `{before, after}` string pair is v1's one supported diff
// input format — no unified-diff-string parsing here (spec.md's "Open Questions, resolved" #2:
// a pair is "easier for Claude to emit correctly"; a future unified-diff parser would itself
// parse into a `{before, after}` pair and call `diffLines`, so this primitive is exactly what
// that follow-on would need — additive later, not a redesign). No third-party diff library
// dependency: the classic O(n*m) LCS dynamic-program over lines, implemented directly below.
// Deterministic and pure — same two strings in, same `DiffLine[]` out, every time.

/** FR11's line-diff record: `text` is the line's own content (no trailing `\n`), `kind` says
 * which side of the `{before, after}` pair it came from. A changed line (`before` line X becomes
 * `after` line Y) is represented as a `"removed"` entry for X immediately followed by an
 * `"added"` entry for Y — this is a line-level diff, not a word-level one, so there is no
 * "changed" kind; two adjacent removed+added entries *is* how a changed line is expressed. */
export interface DiffLine {
  text: string;
  kind: "unchanged" | "added" | "removed";
}

/**
 * Deterministic, pure LCS line diff (spec.md FR11, AC9's golden fixture).
 *
 * `before`/`after` are split on `"\n"` into line arrays, and a standard bottom-up LCS table
 * (`dp[i][j]` = length of the longest common subsequence of `beforeLines[i:]` and
 * `afterLines[j:]`) is built in O(n*m) time/space — line counts in a code block are small (tens
 * of lines), so this straightforward DP is fast enough and stays easy to verify against AC9's
 * exact expected output, unlike a Myers-diff implementation.
 *
 * Backtracking from `dp[0][0]` reconstructs the diff in document order: a matching pair of lines
 * is `"unchanged"`; at a mismatch, the direction that preserves the longer remaining common
 * subsequence is taken, with ties (`dp[i+1][j] === dp[i][j+1]`) broken toward `"removed"` first
 * — this tie-break is what makes a changed line (e.g. `"b"` -> `"x"`) come out as
 * `removed("b")` immediately followed by `added("x")`, matching AC9's exact fixture rather than
 * the reverse order.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const n = beforeLines.length;
  const m = afterLines.length;

  // dp[i][j] = LCS length of beforeLines[i:] and afterLines[j:]. One extra row/column of zeros
  // (indices n and m) is the base case for "nothing left on this side".
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        beforeLines[i] === afterLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (beforeLines[i] === afterLines[j]) {
      result.push({ text: beforeLines[i]!, kind: "unchanged" });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      result.push({ text: beforeLines[i]!, kind: "removed" });
      i++;
    } else {
      result.push({ text: afterLines[j]!, kind: "added" });
      j++;
    }
  }
  // One side may still have a trailing tail once the other is exhausted (e.g. after is longer).
  while (i < n) {
    result.push({ text: beforeLines[i]!, kind: "removed" });
    i++;
  }
  while (j < m) {
    result.push({ text: afterLines[j]!, kind: "added" });
    j++;
  }

  return result;
}
