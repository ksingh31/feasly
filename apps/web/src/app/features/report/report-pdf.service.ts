import { Injectable, inject } from '@angular/core';
import type { ReportSnapshot } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { formatWholeCad } from '../../shared/utils/money';

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
  /** "Your next steps" — title/body pairs from report copy. */
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
 * range, build cost, land, the cost-breakdown rows, the narrative (or its
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
      const lines = doc.splitTextToSize(value, maxWidth);
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
      doc.text(label, margin, y);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(35, 35, 35);
      doc.text(value, pageWidth - margin, y, { align: 'right' });
      y += 16;
    }
    y += 4;
    text(input.uncalibratedNote, { size: 8, gap: 10, color: [130, 130, 130] });
    rule();

    // Cost breakdown.
    if (snap.rows.length > 0) {
      text('Cost breakdown', { size: 13, bold: true, gap: 6 });
      for (const row of snap.rows) {
        need(16);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(35, 35, 35);
        const labelLines = doc.splitTextToSize(row.label, maxWidth - 170);
        doc.text(labelLines, margin, y);
        doc.setFont('helvetica', 'bold');
        doc.text(
          range(row.range.low, row.range.high),
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
    text('Your next steps', { size: 13, bold: true, gap: 6 });
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
