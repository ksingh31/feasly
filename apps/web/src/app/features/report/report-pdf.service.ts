import { Injectable, inject } from '@angular/core';
import type { ReportSnapshot } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { aggregateCostBuckets } from '../../shared/cost-buckets';
import { formatWholeCad } from '../../shared/utils/money';

/**
 * Unicode characters above U+00FF that jsPDF's WinAnsi core-font path CAN
 * encode (the cp1252 extension block, e.g. the em dash and smart quotes the
 * AI narrative uses). Everything else above U+00FF has no WinAnsi mapping.
 */
const WIN_ANSI_EXTRA =
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

/**
 * Strips characters jsPDF 4.x cannot encode in its WinAnsi core-font path.
 *
 * QA bug (feasly-estimate-1.pdf): AI narratives can carry stray invisible
 * characters. jsPDF encodes any line containing a character it cannot map
 * to WinAnsi as UTF-16BE (NUL-interleaved) while the font stays WinAnsi
 * Helvetica — every affected line renders ~2x too wide and gets clipped at
 * the page edge. Empirically (jsPDF 4.2.1 trigger matrix) the line-flipping
 * triggers are: U+0000, and any character above U+00FF with no WinAnsi
 * mapping — notably U+200B (zero-width space) and U+2028, which LLMs emit.
 * Plain C0 controls like \x11 do NOT flip the encoding, but they have no
 * WinAnsi glyph either, so they are stripped too.
 *
 * Kept: \n (paragraph splitting depends on it), \t, printable ASCII, the
 * WinAnsi-native U+00A0–U+00FF range, and the cp1252-mapped extras above
 * (WIN_ANSI_EXTRA) so legitimate punctuation like — ‘’ “” … survives.
 * Pure function: apply at generation time so past and future snapshots are
 * covered.
 */
export function sanitizePdfText(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x09) {
      out += ch; // \n and \t are safe and meaningful
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      // C0 controls, DEL, C1 controls: no WinAnsi glyph — drop.
    } else if (code <= 0xff || WIN_ANSI_EXTRA.includes(ch)) {
      out += ch; // WinAnsi can encode these; jsPDF stays single-byte.
    }
    // Anything else (U+200B, U+2028, arrows, emoji, …) would flip the whole
    // line to UTF-16BE → drop it rather than clip the line.
  }
  return out;
}

export interface ReportPdfInput {
  readonly snapshot: ReportSnapshot;
  /** Display address, e.g. "2631 63 Ave SW, Calgary, AB". */
  readonly address: string;
  /** Report title line, e.g. "New-build cost report". */
  readonly title: string;
  /** Prepared-date line already formatted for display. */
  readonly preparedLine: string;
  /** Version label already formatted, e.g. "Report version 3". */
  readonly versionLine: string;
  /** "Your next three steps" — title/body pairs from report copy. */
  readonly steps: ReadonlyArray<{ title: string; body: string }>;
  /** The deterministic-figures disclaimer line. */
  readonly disclaimer: string;
  /** Uncalibrated planning-figures note shown under the figures. */
  readonly uncalibratedNote: string;
}

/**
 * Client-side report PDF (QA finding: "Download PDF" appeared inert).
 *
 * jsPDF is dynamically imported so the public bundle never pays for it until
 * the user clicks Download PDF. Only core text/vector APIs are used — never
 * `.html()` or FreeText annotations — so the HTML-injection surface behind
 * the published jsPDF CVEs is never touched.
 *
 * The PDF mirrors the on-screen report's core figures: hero total, planning
 * range, build cost, land, the three cost-bucket breakdown rows (shared
 * helper — the same buckets the report page renders), the narrative (or its
 * honest absence), next steps, and the disclaimer.
 */
@Injectable({ providedIn: 'root' })
export class ReportPdfService {
  private readonly config = inject(ConfigService);

  /** Finish-tier display label from config (single source of truth, no duplication). */
  private tierLabel(tier: string): string {
    const tiers = this.config.get('copy').wizard.scopeTiers;
    return tiers.find((t) => t.id === tier)?.name ?? tier;
  }

  /** Fills a `{token}` config template (same helper shape as the report page). */
  private fill(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '');
  }

  async generate(input: ReportPdfInput): Promise<Blob> {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 48;
    const maxWidth = pageWidth - margin * 2;
    let y = margin;

    const need = (height: number): void => {
      if (y + height > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
    };

    const text = (
      value: string,
      opts: { size?: number; bold?: boolean; gap?: number; color?: [number, number, number] } = {},
    ): void => {
      const size = opts.size ?? 10;
      doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
      doc.setFontSize(size);
      doc.setTextColor(...(opts.color ?? [35, 35, 35]));
      // Sanitize BEFORE wrapping: a control char anywhere in the string
      // poisons the whole line's encoding (see sanitizePdfText).
      const lines = doc.splitTextToSize(sanitizePdfText(value), maxWidth);
      const lineHeight = size * 1.35;
      need(lines.length * lineHeight + (opts.gap ?? 6));
      doc.text(lines, margin, y);
      y += lines.length * lineHeight + (opts.gap ?? 6);
    };

    const rule = (): void => {
      need(14);
      doc.setDrawColor(200, 200, 200);
      doc.setLineWidth(0.75);
      doc.line(margin, y, pageWidth - margin, y);
      y += 14;
    };

    const range = (low: number, high: number): string =>
      `${formatWholeCad(low)} – ${formatWholeCad(high)}`;

    const snap = input.snapshot;
    const reportCopy = this.config.get('copy').report;

    // Header.
    text('Feasly', { size: 22, bold: true, gap: 2, color: [26, 26, 26] });
    text(input.title, { size: 12, gap: 10, color: [110, 110, 110] });
    rule();

    // Address + meta.
    text(input.address, { size: 15, bold: true, gap: 2 });
    text(`${input.preparedLine} · ${input.versionLine}`, { size: 9, gap: 10, color: [110, 110, 110] });

    // Key figures.
    text('Estimate summary', { size: 13, bold: true, gap: 6 });
    const figures: Array<[string, string]> = [
      ['Total project cost', range(snap.totalRange.low, snap.totalRange.high)],
      ['Build cost', range(snap.buildRange.low, snap.buildRange.high)],
      ['Land (City assessed value)', formatWholeCad(snap.landValue.value)],
      [
        'Home size & finishes',
        this.fill(reportCopy.pdfInputsLine, {
          sqft: snap.inputs.sqft.toLocaleString('en-CA'),
          tier: this.tierLabel(snap.inputs.tier),
        }),
      ],
    ];
    for (const [label, value] of figures) {
      need(16);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(110, 110, 110);
      doc.text(sanitizePdfText(label), margin, y);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(35, 35, 35);
      doc.text(sanitizePdfText(value), pageWidth - margin, y, { align: 'right' });
      y += 16;
    }
    y += 4;
    text(input.uncalibratedNote, { size: 8, gap: 10, color: [130, 130, 130] });
    rule();

    // Cost breakdown — the same three buckets the on-screen report renders
    // (shared aggregateCostBuckets helper, D-01). Land is its own figure in
    // the summary above, never a breakdown row. The page shows each bucket's
    // base figure, so the PDF mirrors that exactly.
    const buckets = aggregateCostBuckets(snap.rows);
    if (snap.rows.length > 0) {
      // Keep the heading with the first bucket row (no orphaned heading).
      need(13 * 1.35 + 6 + 16);
      text('Cost breakdown', { size: 13, bold: true, gap: 6 });
      for (const bucket of buckets) {
        need(16);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(35, 35, 35);
        const labelLines = doc.splitTextToSize(sanitizePdfText(bucket.label), maxWidth - 170);
        doc.text(labelLines, margin, y);
        doc.setFont('helvetica', 'bold');
        doc.text(
          formatWholeCad(bucket.range.base),
          pageWidth - margin,
          y,
          { align: 'right' },
        );
        y += Math.max(1, labelLines.length) * 13.5 + 4;
      }
      y += 6;
      rule();
    }

    // Narrative (or its honest absence — never invented). When every model
    // failed (BE-9) the snapshot carries the static Calgary guide labeled
    // 'static-guide': render it under its own honest title, never as an
    // AI summary.
    const isStaticGuide = snap.narrativeSource === 'static-guide';
    // Keep the heading with the first narrative line (no orphaned heading).
    need(13 * 1.35 + 6 + 10 * 1.35 + 10);
    text(isStaticGuide ? reportCopy.staticGuideTitle : 'Summary', {
      size: 13,
      bold: true,
      gap: 6,
    });
    if (isStaticGuide) {
      text(reportCopy.staticGuideNote, { size: 9, gap: 4 });
    }
    const narrative = snap.narrative?.trim();
    text(
      narrative || reportCopy.pdfNarrativeFallback,
      { size: 10, gap: 10 },
    );
    rule();

    // What's not in this estimate — the same honest exclusions as the
    // on-screen report. Trust builder: no surprise "that wasn't included".
    // New-build only: the line items assume new construction.
    if (snap.projectType !== 'renovation') {
      text(reportCopy.exclusionsTitle, { size: 13, bold: true, gap: 6 });
      text(reportCopy.includedLine, { size: 10, gap: 4 });
      for (const item of reportCopy.exclusions) {
        text(`• ${item}`, { size: 10, gap: 4 });
      }
      rule();
    }

    // Next steps.
    text('Your next three steps', { size: 13, bold: true, gap: 6 });
    input.steps.forEach((step, i) => {
      text(`${i + 1}. ${step.title}`, { size: 10, bold: true, gap: 2 });
      text(step.body, { size: 10, gap: 8 });
    });
    rule();

    // Disclaimer.
    text(input.disclaimer, { size: 8, gap: 0, color: [130, 130, 130] });

    return doc.output('blob');
  }
}
