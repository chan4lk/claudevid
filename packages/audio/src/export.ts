// SRT/VTT export from a `WordTiming[]` (spec.md FR9, AC9).
//
// Cue-grouping choice (Rule 2, Simplicity First): one cue per word. A phrase-segmentation
// heuristic (grouping words into readable multi-word lines, breaking on punctuation/gaps) is
// explicitly out of scope for this task — the spec only requires a readable, correctly-timed
// subtitle file, and per-word cues are trivially correct (no run-grouping logic to get wrong) and
// still readable in every SRT/VTT player. If a future change wants multi-word cues, this is the
// seam to extend, not rewrite.
//
// Estimated-word marker choice: `estimated: true` words are wrapped in a plain-text bracket
// marker, `[estimated]word[/estimated]`, in both SRT and VTT output. A plain-text marker (rather
// than `<i>`/other markup) is used for both formats so the same marking logic works identically
// in SRT and VTT without relying on a renderer's willingness to honor HTML-like tags (many basic
// SRT players ignore or strip them) — AC9 only requires the estimated span to be *visibly
// distinguishable*, not a specific markup syntax.

import type { WordTiming } from "./word-timing-types.js";

/** Wraps `word.word` in a bracket marker when `word.estimated` is true (see header comment for
 * why a plain-text marker was chosen over HTML-like markup). */
function formatCueText(word: WordTiming): string {
  return word.estimated ? `[estimated]${word.word}[/estimated]` : word.word;
}

/** Formats `totalSeconds` as `HH:MM:SS` + a millisecond separator (`,` for SRT, `.` for VTT). */
function formatTimestamp(totalSeconds: number, millisSeparator: string): string {
  const totalMillis = Math.round(totalSeconds * 1000);
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");

  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}${millisSeparator}${pad3(millis)}`;
}

/** Generates an SRT subtitle file from `timings` (spec.md FR9): one cue per word (see header
 * comment), sequential integer cue numbers starting at 1, `HH:MM:SS,mmm --> HH:MM:SS,mmm`
 * timestamp lines, `estimated: true` words wrapped in a `[estimated]...[/estimated]` marker
 * (AC9). Returns `""` for an empty `timings` array. */
export function exportSrt(timings: WordTiming[]): string {
  if (timings.length === 0) return "";

  return timings
    .map((word, index) => {
      const start = formatTimestamp(word.start, ",");
      const end = formatTimestamp(word.end, ",");
      return `${index + 1}\n${start} --> ${end}\n${formatCueText(word)}\n`;
    })
    .join("\n");
}

/** Generates a WebVTT subtitle file from `timings` (spec.md FR9): a `WEBVTT` header line, one cue
 * per word (see header comment), `HH:MM:SS.mmm --> HH:MM:SS.mmm` timestamp lines,
 * `estimated: true` words wrapped in a `[estimated]...[/estimated]` marker (AC9). Returns a
 * header-only `"WEBVTT\n"` for an empty `timings` array — still a structurally valid VTT file. */
export function exportVtt(timings: WordTiming[]): string {
  if (timings.length === 0) return "WEBVTT\n";

  const cues = timings.map((word) => {
    const start = formatTimestamp(word.start, ".");
    const end = formatTimestamp(word.end, ".");
    return `${start} --> ${end}\n${formatCueText(word)}\n`;
  });

  return `WEBVTT\n\n${cues.join("\n")}`;
}
