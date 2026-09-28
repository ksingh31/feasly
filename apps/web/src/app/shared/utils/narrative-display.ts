/**
 * Narrative display paragraphs for the estimate report.
 *
 * New narratives (post-#314) are plain-text neighbourhood guides whose
 * paragraphs are separated by blank lines — they pass through untouched.
 *
 * Older stored narratives may carry markdown (bold markers, `---`
 * separators, pipe tables) or past generation glitches (a duplicated or
 * mid-sentence-truncated guide with the compliance footer appended after).
 * Those degrade gracefully to readable plain-text paragraphs: markdown is
 * cleaned, an exactly-duplicated narrative collapses to one copy, and the
 * footer always renders as its own paragraph instead of fusing with the
 * last line of prose.
 *
 * Pure function (string in → strings out): no DOM, no Angular, fully
 * unit-testable.
 */

/** Split a stored narrative into display-ready paragraphs. */
export function narrativeDisplayParagraphs(narrative: string): string[] {
  let text = (narrative ?? '').trim();
  if (!text) {
    return [];
  }

  // B2: collapse an exactly-duplicated narrative (a past generation glitch
  // stored the guide twice) to a single copy.
  text = dedupeDoubledText(text);

  // Inline `---` separators become paragraph breaks before splitting, so a
  // legacy "...sq ft. --- **Cost estimate** | table..." run renders as
  // separate paragraphs instead of one fused line. Only standalone
  // separators (whitespace-bounded, never adjacent to a pipe) qualify —
  // markdown table dividers like |------| are handled by the table
  // cleanup below instead.
  text = text.replace(/(^|\s)-{3,}(?=\s|$)/g, '\n\n');

  const blocks = text
    .split(/\n\s*\n/)
    .flatMap((block) => cleanLegacyMarkdown(block).split(/\n\s*\n/))
    .map((block) => block.trim())
    // Drop empties and blocks that are only pipes/dashes/colons (table
    // divider residue) — never real prose.
    .filter((block) => block.length > 0 && !/^[\s|:\-~]+$/.test(block));

  // B2: drop consecutive duplicate blocks (a partial re-emission of the
  // guide). A legitimate guide never repeats a paragraph back-to-back.
  return blocks.filter((block, index) => index === 0 || block !== blocks[index - 1]);
}

/**
 * When the whole narrative is exactly two identical halves (whitespace
 * aside), keep one. Only fires on exact duplication — real prose never
 * has two identical halves.
 */
function dedupeDoubledText(text: string): string {
  if (text.length < 2) {
    return text;
  }
  const mid = Math.floor(text.length / 2);
  const first = text.slice(0, mid).trim();
  const second = text.slice(mid).trim();
  if (first.length > 0 && first === second) {
    return first;
  }
  return text;
}

/**
 * Light legacy-markdown cleanup for one paragraph block: strip bold
 * markers, drop horizontal rules and markdown table separator rows, turn
 * pipe-table rows into readable "cell · cell" lines, strip heading
 * markers. Plain prose passes through byte-identical.
 */
function cleanLegacyMarkdown(block: string): string {
  const lines: string[] = [];
  for (const rawLine of block.split('\n')) {
    let line = rawLine.trim();
    if (!line) {
      continue;
    }
    // Horizontal rules: ---, ***, ___.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      continue;
    }
    // Markdown table separator rows: |------|------|.
    if (line.includes('|') && line.includes('-') && /^\|?[\s:|~-]+\|?$/.test(line)) {
      continue;
    }
    // ATX headings: strip the markers, keep the text.
    line = line.replace(/^#{1,6}\s+/, '');
    // Pipe-table rows: "a | b | c" -> one "a · b · c" line per table row
    // (divider cells start a new row). Rows are joined with a blank line so
    // each renders as its own paragraph downstream.
    if (line.includes('|')) {
      const rawCells = line
        .split('|')
        .map((cell) => cell.trim().replace(/\*\*/g, '').replace(/__/g, ''));
      const rows: string[][] = [[]];
      for (const cell of rawCells) {
        if (!cell) {
          continue;
        }
        if (/^:?-+:?$/.test(cell)) {
          if (rows[rows.length - 1].length > 0) {
            rows.push([]);
          }
          continue;
        }
        rows[rows.length - 1].push(cell);
      }
      const textRows = rows.filter((row) => row.length > 0).map((row) => row.join(' · '));
      if (textRows.length > 0) {
        line = textRows.join('\n\n');
      }
    }
    lines.push(line);
  }
  return lines.join('\n').replace(/\*\*/g, '').replace(/__/g, '');
}
