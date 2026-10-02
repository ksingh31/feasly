import { Injectable, inject } from '@angular/core';
import type { ReportSnapshot } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { aggregateCostBuckets, type CostBucket } from '../../shared/cost-buckets';
import { dollarsToCents, formatCentsToCad, formatWholeCad } from '../../shared/utils/money';

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
 * Kept: \t, \n (paragraph splitting depends on it), printable ASCII, the
 * WinAnsi-native U+00A0–U+00FF range, and the cp1252-mapped extras
 * (€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ) so legitimate punctuation like — ‘’ “”
 * survives. Written as a single regex (not a char loop) to keep the
 * production bundle small — the lighthouse script-size budget is tight.
 * Pure function: apply at generation time so past and future snapshots are
 * covered.
 */
export function sanitizePdfText(value: string): string {
  return value.replace(
    /[^\t\n\x20-\x7E\xA0-\u00FF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g,
    '',
  );
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

// ---------------------------------------------------------------------------
// Brand typefaces.
//
// Karan-locked typography (2026-09-24): Manrope = hero figure + section
// headings, Instrument Sans = everything else. jsPDF core fonts are
// Helvetica-only, so the real brand faces are fetched at generation time
// from the app's own static assets (/fonts/*.ttf, copied from public/ at
// build time) and embedded via addFileToVFS/addFont. The fetch happens once
// per page-load (module-level promise cache) and never touches the JS
// bundle — jsPDF itself stays dynamically imported. Every failure (offline,
// 404, timeout, corrupt file) degrades gracefully to Helvetica; the layout
// measures text with whichever font is actually active, so the fallback can
// never overflow the margins.
// ---------------------------------------------------------------------------

/** Base64 TTF payloads, or null per slot when the fetch failed. */
export interface BrandFontFiles {
  readonly heading: string | null;
  /** Manrope Bold — hero figure + section headings. */
  readonly body: string | null;
  /** Instrument Sans Regular — body copy. */
  readonly bodyBold: string | null; /** Instrument Sans Bold — emphasis. */
}

const FONT_ASSETS = [
  ['fonts/manrope-bold.ttf', 'heading'],
  ['fonts/instrument-sans.ttf', 'body'],
  ['fonts/instrument-sans-bold.ttf', 'bodyBold'],
] as const;

const FONT_FETCH_TIMEOUT_MS = 5000;

function base64Encode(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function fetchFontFile(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FONT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Reject HTML error pages masquerading as fonts, and empty responses.
    if (bytes.length < 256 || bytes[0] === 0x3c) return null;
    return base64Encode(bytes);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let brandFontsPromise: Promise<BrandFontFiles> | null = null;

/**
 * Loads the brand TTFs once per page-load. Exported for tests (the margin
 * regression test measures with the same faces the PDF was drawn with).
 */
export function loadBrandFonts(): Promise<BrandFontFiles> {
  if (!brandFontsPromise) {
    brandFontsPromise = (async (): Promise<BrandFontFiles> => {
      const base = typeof document !== 'undefined' ? document.baseURI : '/';
      const [heading, body, bodyBold] = await Promise.all(
        FONT_ASSETS.map(([file]) => fetchFontFile(new URL(file, base).toString())),
      );
      return { heading, body, bodyBold };
    })();
  }
  return brandFontsPromise;
}

/** Test hook: reset the module-level font cache between specs. */
export function resetBrandFontsForTests(): void {
  brandFontsPromise = null;
}

// ---------------------------------------------------------------------------
// Brand theme — mirrors apps/web/src/styles.scss :root.
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

const THEME = {
  page: [247, 244, 239] as Rgb, // --cream #f7f4ef
  card: [255, 255, 255] as Rgb, // --card
  cardBorder: [226, 218, 205] as Rgb, // warm hairline ≈ rgba(26,22,18,.1)
  text: [26, 22, 18] as Rgb, // --text #1a1612
  muted: [122, 110, 98] as Rgb, // --muted #7a6e62
  brass: [168, 118, 26] as Rgb, // --accent #a8761a
  bronze: [110, 84, 16] as Rgb, // --accent-deep #6e5410 (text-safe brass)
  brassWash: [249, 245, 237] as Rgb, // --accent-bg over white
  bucket: {
    structure: [168, 118, 26] as Rgb, // .bucket-structure
    interior: [180, 85, 45] as Rgb, // .bucket-interior
    design: [111, 122, 58] as Rgb, // .bucket-design
  },
} as const;

const BUCKET_FILL: Record<CostBucket['key'], Rgb> = {
  structure: THEME.bucket.structure,
  interior: THEME.bucket.interior,
  design: THEME.bucket.design,
};
// ---------------------------------------------------------------------------
// Layout engine — atom-based, in the sample report's visual language.
//
// An Atom is a pre-measured block (heading, paragraph, bucket row, step…).
// Cards collect atoms and draw their background only once the fragment's
// height is known, so backgrounds never slice mid-block; a card taller than
// a page continues as a second stacked card. Every text measurement uses the
// font that will actually draw the text (brand face or Helvetica fallback),
// which is what keeps the right-margin guarantee intact.
// ---------------------------------------------------------------------------

type JsPdfDoc = InstanceType<typeof import('jspdf').jsPDF>;

interface TextRun {
  readonly font: 'heading' | 'body';
  readonly bold: boolean;
  readonly size: number;
  readonly color: Rgb;
}

/** A measured block: draws within `height` pt at (x, topY) inside width w. */
interface Atom {
  readonly height: number;
  draw(x: number, topY: number, w: number): void;
  /** Split into [head, tail] with head fitting maxHeight; null when not splittable. */
  split?(maxHeight: number): [Atom, Atom] | null;
}

interface CardStyle {
  readonly fill?: Rgb;
  readonly border?: Rgb;
  readonly borderWidth?: number;
  readonly pad?: number;
  readonly gapAfter?: number;
}

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 44;
/** Never start a card/fragment with less than this much vertical room. */
const MIN_FRESH_SPACE = 72;

class PdfLayout {
  y = MARGIN;
  readonly contentW = PAGE_W - MARGIN * 2;

  constructor(
    readonly doc: JsPdfDoc,
    private readonly useHeadingFont: boolean,
    private readonly useBodyFont: boolean,
    private readonly useBodyBoldFont: boolean,
  ) {
    this.paintBackground();
  }

  // -- font state -----------------------------------------------------------

  private setRun(run: TextRun): void {
    const { doc } = this;
    if (run.font === 'heading' && this.useHeadingFont) {
      doc.setFont('manrope-bold', 'bold');
    } else if (run.font === 'body' && this.useBodyFont) {
      // Bold degrades to the regular face when the bold TTF failed to load.
      doc.setFont(run.bold && this.useBodyBoldFont ? 'instrumentsans-bold' : 'instrumentsans', 'normal');
    } else {
      doc.setFont('helvetica', run.bold ? 'bold' : 'normal');
    }
    doc.setFontSize(run.size);
    doc.setTextColor(run.color[0], run.color[1], run.color[2]);
  }

  /** Wrapped + sanitized lines — the single text-measurement choke point. */
  lines(text: string, run: TextRun, maxWidth: number): string[] {
    this.setRun(run);
    return this.doc.splitTextToSize(sanitizePdfText(text), maxWidth);
  }

  textWidth(text: string, run: TextRun): number {
    this.setRun(run);
    return this.doc.getTextWidth(sanitizePdfText(text));
  }

  private baseline(topY: number, size: number): number {
    return topY + size * 0.82;
  }

  /** Draws pre-wrapped lines; returns the vertical space consumed. */
  private drawLines(lines: string[], run: TextRun, x: number, topY: number): number {
    if (lines.length === 0) return 0;
    this.setRun(run);
    this.doc.text(lines, x, this.baseline(topY, run.size));
    return lines.length * run.size * 1.35;
  }

  private drawRun(text: string, run: TextRun, x: number, topY: number): void {
    this.setRun(run);
    this.doc.text(sanitizePdfText(text), x, this.baseline(topY, run.size));
  }

  // -- page -----------------------------------------------------------------

  private paintBackground(): void {
    this.doc.setFillColor(THEME.page[0], THEME.page[1], THEME.page[2]);
    this.doc.rect(0, 0, PAGE_W, PAGE_H, 'F');
  }

  private newPage(): void {
    this.doc.addPage();
    this.paintBackground();
    this.y = MARGIN;
  }

  private remaining(): number {
    return PAGE_H - MARGIN - this.y;
  }

  /** Page footers: brass hairline + wordmark line + page numbers, every page. */
  finishPages(title: string): void {
    const { doc } = this;
    const total = doc.getNumberOfPages();
    const run: TextRun = { font: 'body', bold: false, size: 8, color: THEME.muted };
    for (let i = 1; i <= total; i++) {
      doc.setPage(i);
      const fy = PAGE_H - 30;
      doc.setDrawColor(THEME.brass[0], THEME.brass[1], THEME.brass[2]);
      doc.setLineWidth(0.75);
      doc.line(MARGIN, fy, PAGE_W - MARGIN, fy);
      this.setRun(run);
      doc.text(sanitizePdfText(`Feasly · ${title}`), MARGIN, fy + 13);
      doc.text(`Page ${i} of ${total}`, PAGE_W - MARGIN, fy + 13, { align: 'right' });
    }
  }

  // -- atoms ------------------------------------------------------------------

  /** Single-style wrapped paragraph. Splittable across pages by lines. */
  text(width: number, text: string, run: TextRun, gapAfter = 6): Atom {
    const lh = run.size * 1.35;
    const make = (ls: string[]): Atom => ({
      height: ls.length * lh + (ls.length > 0 ? gapAfter : 0),
      draw: (x, topY) => {
        this.drawLines(ls, run, x, topY);
      },
      split: (maxH: number): [Atom, Atom] | null => {
        const fits = (n: number): boolean => n * lh + gapAfter <= maxH;
        if (fits(ls.length) || ls.length < 2) return null;
        let n = Math.max(1, Math.floor((maxH - gapAfter) / lh));
        if (n >= ls.length) return null;
        if (!fits(n)) return null;
        return [make(ls.slice(0, n)), make(ls.slice(n))];
      },
    });
    return make(this.lines(text, run, width));
  }

  /** Section heading — Manrope bold, charcoal (sample: .card h2). */
  heading(width: number, text: string): Atom {
    return this.text(width, text, { font: 'heading', bold: true, size: 15, color: THEME.text }, 10);
  }

  /** Eyebrow label — uppercase, muted (sample: .figure-card h2). */
  eyebrow(width: number, text: string): Atom {
    return this.text(
      width,
      text.toUpperCase(),
      { font: 'body', bold: true, size: 10.5, color: THEME.muted },
      8,
    );
  }

  /** The one prominent total — Manrope bold (sample: .hero-value). */
  heroFigure(width: number, text: string): Atom {
    return this.text(width, text, { font: 'heading', bold: true, size: 38, color: THEME.text }, 8);
  }

  /** Card figure — Manrope bold (sample: .figure-single). */
  figure(width: number, text: string): Atom {
    return this.text(width, text, { font: 'heading', bold: true, size: 24, color: THEME.text }, 8);
  }

  /** One line mixing runs, e.g. muted label + bold figure (sample: .planning-range). */
  mixed(width: number, parts: ReadonlyArray<{ text: string; run: TextRun }>, gapAfter = 6): Atom {
    const widths = parts.map((p) => this.textWidth(p.text, p.run));
    const size = Math.max(...parts.map((p) => p.run.size));
    // Mixed lines are short by construction; wrap only as a safety net.
    const total = widths.reduce((a, b) => a + b, 0);
    if (total <= width) {
      return {
        height: size * 1.35 + gapAfter,
        draw: (x, topY) => {
          let cx = x;
          parts.forEach((p, i) => {
            this.drawRun(p.text, p.run, cx, topY);
            cx += widths[i] ?? 0;
          });
        },
      };
    }
    // Fallback: stack the parts as separate lines (never overflow).
    const atoms = parts.map((p) => this.text(width, p.text, p.run, 2));
    const height = atoms.reduce((a, at) => a + at.height, 0) + gapAfter;
    return {
      height,
      draw: (x, topY, w) => {
        let ay = topY;
        for (const at of atoms) {
          at.draw(x, ay, w);
          ay += at.height;
        }
      },
    };
  }

  /** Thin warm hairline inside a card (sample: .tier-display border-top). */
  hairline(width: number): Atom {
    return {
      height: 13,
      draw: (x, topY, w) => {
        const hw = w || width;
        this.doc.setDrawColor(THEME.cardBorder[0], THEME.cardBorder[1], THEME.cardBorder[2]);
        this.doc.setLineWidth(1);
        this.doc.line(x, topY + 6, x + hw, topY + 6);
      },
    };
  }

  spacer(height: number): Atom {
    return { height, draw: () => undefined };
  }

  /** Brass-wash callout strip (sample: .uncalibrated-note badge). */
  callout(width: number, text: string): Atom {
    const run: TextRun = { font: 'body', bold: false, size: 9.5, color: THEME.text };
    const lines = this.lines(text, run, width - 28);
    const height = lines.length * run.size * 1.45 + 22;
    return {
      height: height + 12,
      draw: (x, topY, w) => {
        const cw = w || width;
        this.doc.setFillColor(THEME.brassWash[0], THEME.brassWash[1], THEME.brassWash[2]);
        this.doc.setDrawColor(THEME.brass[0], THEME.brass[1], THEME.brass[2]);
        this.doc.setLineWidth(1);
        this.doc.roundedRect(x, topY, cw, height, 8, 8, 'FD');
        this.drawLines(lines, run, x + 14, topY + 11);
      },
    };
  }

  /** Stacked proportional bar (sample: .buckets-bar) with rounded end caps. */
  bucketBar(width: number, buckets: readonly CostBucket[]): Atom {
    const bh = 20;
    const radius = 7;
    const height = bh + 12;
    const segs = buckets.filter((b) => b.range.base > 0);
    const total = segs.reduce((a, b) => a + b.range.base, 0);
    return {
      height,
      draw: (x, topY, w) => {
        const bw = w || width;
        const { doc } = this;
        if (segs.length === 0 || total <= 0) return;
        let sx = x;
        segs.forEach((seg, i) => {
          const sw = i === segs.length - 1 ? x + bw - sx : (bw * seg.range.base) / total;
          const fill = BUCKET_FILL[seg.key];
          doc.setFillColor(fill[0], fill[1], fill[2]);
          if (segs.length === 1) {
            doc.roundedRect(sx, topY, sw, bh, radius, radius, 'F');
          } else if (i === 0) {
            // Rounded left cap, square joint: cover the right rounding.
            if (sw > radius) {
              doc.roundedRect(sx, topY, sw, bh, radius, radius, 'F');
              doc.rect(sx + sw - radius, topY, radius, bh, 'F');
            } else {
              doc.rect(sx, topY, sw, bh, 'F');
            }
          } else if (i === segs.length - 1) {
            // Square joint, rounded right cap.
            if (sw > radius) {
              doc.roundedRect(sx, topY, sw, bh, radius, radius, 'F');
              doc.rect(sx, topY, radius, bh, 'F');
            } else {
              doc.rect(sx, topY, sw, bh, 'F');
            }
          } else {
            doc.rect(sx, topY, sw, bh, 'F');
          }
          sx += sw;
        });
      },
    };
  }

  /** Legend row: color dot + label + right-aligned amount (sample: .bucket-legend). */
  bucketRow(width: number, bucket: CostBucket): Atom {
    const labelRun: TextRun = { font: 'body', bold: false, size: 11, color: THEME.text };
    const amountRun: TextRun = { font: 'body', bold: true, size: 11, color: THEME.text };
    const amount = formatWholeCad(bucket.range.base);
    const labelLines = this.lines(bucket.label, labelRun, width - 170);
    const height = Math.max(14, labelLines.length * labelRun.size * 1.35) + 8;
    return {
      height,
      draw: (x, topY, w) => {
        const rw = w || width;
        const fill = BUCKET_FILL[bucket.key];
        this.doc.setFillColor(fill[0], fill[1], fill[2]);
        const dotY = topY + 1;
        this.doc.roundedRect(x, dotY, 11, 11, 3, 3, 'F');
        this.drawLines(labelLines, labelRun, x + 19, topY);
        this.setRun(amountRun);
        this.doc.text(sanitizePdfText(amount), x + rw, this.baseline(topY, amountRun.size), {
          align: 'right',
        });
      },
    };
  }

  /** Numbered step with brass-wash circle (sample: .steps li::before). */
  step(width: number, index: number, title: string, bodyText: string): Atom {
    const gutter = 40;
    const titleRun: TextRun = { font: 'body', bold: true, size: 11, color: THEME.text };
    const bodyRun: TextRun = { font: 'body', bold: false, size: 10, color: THEME.muted };
    const titleLines = this.lines(title, titleRun, width - gutter);
    const bodyLines = this.lines(bodyText, bodyRun, width - gutter);
    const textH = titleLines.length * titleRun.size * 1.35 + 4 + bodyLines.length * bodyRun.size * 1.4;
    const height = Math.max(30, textH) + 12;
    const label = String(index);
    return {
      height,
      draw: (x, topY, w) => {
        const cw = w || width;
        const cx = x + 14;
        const cy = topY + 14;
        this.doc.setFillColor(THEME.brassWash[0], THEME.brassWash[1], THEME.brassWash[2]);
        this.doc.circle(cx, cy, 13, 'F');
        const numRun: TextRun = { font: 'heading', bold: true, size: 13, color: THEME.bronze };
        const tw = this.textWidth(label, numRun);
        this.setRun(numRun);
        this.doc.text(sanitizePdfText(label), cx - tw / 2, cy + 4.5);
        const tx = x + gutter;
        let ay = topY;
        ay += this.drawLines(titleLines, titleRun, tx, ay);
        ay += 4;
        this.drawLines(bodyLines, bodyRun, tx, ay);
        void cw;
      },
    };
  }

  /** Bulleted exclusion line. */
  bullet(width: number, text: string): Atom {
    const run: TextRun = { font: 'body', bold: false, size: 10.5, color: THEME.text };
    const lines = this.lines(text, run, width - 18);
    const height = lines.length * run.size * 1.35 + 6;
    return {
      height,
      draw: (x, topY) => {
        this.drawRun('•', run, x, topY);
        this.drawLines(lines, run, x + 16, topY);
      },
    };
  }

  // -- composition ------------------------------------------------------------

  gap(height: number): void {
    if (this.remaining() < height) {
      this.newPage();
      return;
    }
    this.y += height;
  }

  /** Brass section rule (sample: section rhythm). */
  brassRule(): void {
    if (this.remaining() < 16) this.newPage();
    this.doc.setDrawColor(THEME.brass[0], THEME.brass[1], THEME.brass[2]);
    this.doc.setLineWidth(1.25);
    this.doc.line(MARGIN, this.y, PAGE_W - MARGIN, this.y);
    this.y += 16;
  }

  private drawCardBg(x: number, topY: number, w: number, h: number, style: CardStyle): void {
    const { doc } = this;
    const fill = style.fill ?? THEME.card;
    const border = style.border ?? THEME.cardBorder;
    doc.setFillColor(fill[0], fill[1], fill[2]);
    doc.setDrawColor(border[0], border[1], border[2]);
    doc.setLineWidth(style.borderWidth ?? 1);
    doc.roundedRect(x, topY, w, h, 10, 10, 'FD');
  }

  /**
   * Renders atoms inside a card. A card that outgrows the page continues as
   * a second stacked card; atoms are never sliced (long paragraphs split by
   * lines via Atom.split).
   */
  card(atoms: readonly Atom[], style: CardStyle = {}): void {
    const pad = style.pad ?? 20;
    const innerW = this.contentW - pad * 2;
    const gapAfter = style.gapAfter ?? 14;
    let list = [...atoms];
    let i = 0;
    while (i < list.length) {
      if (this.remaining() < MIN_FRESH_SPACE) this.newPage();
      const fragTop = this.y;
      let fragH = pad;
      let j = i;
      while (j < list.length) {
        const ah = list[j]?.height ?? 0;
        if (fragH + ah + pad > this.remaining()) {
          if (j === i) {
            // Single atom too tall for a fresh page: split its lines.
            const splittable = list[j];
            const parts = splittable?.split?.(this.remaining() - pad * 2);
            if (splittable && parts) {
              list = [...list.slice(0, j), parts[0], parts[1], ...list.slice(j + 1)];
              continue;
            }
            // Unsplittable behemoth: let it overflow rather than loop forever.
          }
          break;
        }
        fragH += ah;
        j++;
      }
      if (j === i) {
        // Nothing fit (degenerate): force the atom to avoid stalling.
        j = i + 1;
        fragH += list[i]?.height ?? 0;
      }
      fragH += pad;
      this.drawCardBg(MARGIN, fragTop, this.contentW, fragH, style);
      let ay = fragTop + pad;
      for (let k = i; k < j; k++) {
        list[k]?.draw(MARGIN + pad, ay, innerW);
        ay += list[k]?.height ?? 0;
      }
      this.y = fragTop + fragH;
      i = j;
      if (i < list.length) this.newPage();
    }
    this.y += gapAfter;
  }

  /** Plain page-break-aware atom flow (no card background). */
  flow(atoms: readonly Atom[]): void {
    let list = [...atoms];
    let i = 0;
    while (i < list.length) {
      if (this.remaining() < MIN_FRESH_SPACE) this.newPage();
      const atom = list[i];
      if (!atom) {
        i++;
        continue;
      }
      if (atom.height > this.remaining()) {
        const parts = atom.split?.(this.remaining());
        if (parts) {
          list = [...list.slice(0, i), parts[0], parts[1], ...list.slice(i + 1)];
          continue;
        }
        if (this.y > MARGIN) {
          this.newPage();
          continue;
        }
        // Fresh page and still too tall: draw anyway (overflow, never stall).
      }
      atom.draw(MARGIN, this.y, this.contentW);
      this.y += atom.height;
      i++;
    }
  }

  /**
   * Two side-by-side cards (sample: .hero-sub). Falls back to stacked cards
   * when the pair cannot fit on one page.
   */
  twoColumn(
    left: readonly Atom[],
    right: readonly Atom[],
    leftStyle: CardStyle = {},
    rightStyle: CardStyle = {},
  ): void {
    const gap = 12;
    const pad = 20;
    const colW = (this.contentW - gap) / 2;
    const innerW = colW - pad * 2;
    const colH = (atoms: readonly Atom[]): number =>
      pad * 2 + atoms.reduce((a, at) => a + at.height, 0);
    const h = Math.max(colH(left), colH(right));
    if (h > PAGE_H - MARGIN * 2) {
      this.card(left, leftStyle);
      this.card(right, rightStyle);
      return;
    }
    if (h > this.remaining()) this.newPage();
    const topY = this.y;
    this.drawCardBg(MARGIN, topY, colW, h, leftStyle);
    this.drawCardBg(MARGIN + colW + gap, topY, colW, h, rightStyle);
    let ay = topY + pad;
    for (const at of left) {
      at.draw(MARGIN + pad, ay, innerW);
      ay += at.height;
    }
    ay = topY + pad;
    for (const at of right) {
      at.draw(MARGIN + colW + gap + pad, ay, innerW);
      ay += at.height;
    }
    this.y = topY + h + 14;
  }
}
/**
 * Client-side report PDF in the sample report's visual language
 * (Karan 2026-10-02: "match the design for the pdf to how sample looks").
 *
 * Cream page, white cards with warm hairlines, brass rules and accents,
 * Manrope hero figure + section headings, Instrument Sans body — the same
 * tokens as apps/web/src/styles.scss. Cost breakdown uses the shared
 * aggregateCostBuckets() helper (exactly three buckets, land excluded), and
 * sanitizePdfText stays at every text choke point so the control-character
 * clipping fix (PR #403) is not regressed.
 *
 * jsPDF is dynamically imported so the public bundle never pays for it until
 * the user clicks Download PDF. Only core text/vector APIs are used — never
 * `.html()` or FreeText annotations — so the HTML-injection surface behind
 * the published jsPDF CVEs is never touched.
 */
@Injectable({ providedIn: 'root' })
export class ReportPdfService {
  private readonly config = inject(ConfigService);

  /** Finish-tier display label from config (single source of truth, no duplication). */
  private tierLabel(tier: string): string {
    const tiers = this.config.get('copy').wizard.scopeTiers;
    return tiers.find((t) => t.id === tier)?.name ?? tier;
  }

  async generate(input: ReportPdfInput): Promise<Blob> {
    const { jsPDF } = await import('jspdf');
    const fonts = await loadBrandFonts();
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });

    // Embed the brand faces; each failure degrades to Helvetica for that slot.
    // The layout measures with the active font, so fallback can never overflow.
    let useHeading = false;
    let useBody = false;
    let useBodyBold = false;
    if (fonts.heading) {
      doc.addFileToVFS('manrope-bold.ttf', fonts.heading);
      doc.addFont('manrope-bold.ttf', 'manrope-bold', 'bold');
      useHeading = true;
    }
    if (fonts.body) {
      doc.addFileToVFS('instrument-sans.ttf', fonts.body);
      doc.addFont('instrument-sans.ttf', 'instrumentsans', 'normal');
      useBody = true;
    }
    if (fonts.bodyBold) {
      doc.addFileToVFS('instrument-sans-bold.ttf', fonts.bodyBold);
      // Distinct family name (not a style of instrumentsans) so the emitted
      // /BaseFont stays distinguishable for measurement and debugging.
      doc.addFont('instrument-sans-bold.ttf', 'instrumentsans-bold', 'normal');
      useBodyBold = true;
    }

    const L = new PdfLayout(doc, useHeading, useBody, useBodyBold);
    const snap = input.snapshot;
    const reportCopy = this.config.get('copy').report;
    const w = L.contentW;
    const inner = w - 40; // card pad 20 each side
    const isReno = snap.projectType === 'renovation';

    const muted = (size: number, bold = false): TextRun => ({
      font: 'body',
      bold,
      size,
      color: THEME.muted,
    });
    const bodyRun = (size = 10.5, bold = false): TextRun => ({
      font: 'body',
      bold,
      size,
      color: THEME.text,
    });
    const range = (low: number, high: number): string =>
      `${formatWholeCad(low)} – ${formatWholeCad(high)}`;

    // -- Header: wordmark + title, brass rule. --
    L.flow([
      L.text(w, 'Feasly', { font: 'heading', bold: true, size: 22, color: THEME.text }, 2),
      L.text(w, input.title, muted(11), 10),
    ]);
    L.brassRule();

    // -- Address + meta. --
    L.flow([
      L.text(w, input.address, { font: 'heading', bold: true, size: 16, color: THEME.text }, 4),
      L.text(w, `${input.preparedLine} · ${input.versionLine}`, muted(9.5), 0),
    ]);
    L.gap(16);

    // -- HERO card: one prominent total + planning range (sample: .hero-total). --
    L.card(
      [
        L.eyebrow(inner, reportCopy.totalLabel),
        L.heroFigure(inner, formatWholeCad(snap.totalRange.base)),
        L.mixed(
          inner,
          [
            { text: `${reportCopy.planningRangeLabel}  `, run: muted(11.5) },
            {
              text: range(snap.totalRange.low, snap.totalRange.high),
              run: { font: 'body', bold: true, size: 11.5, color: THEME.text },
            },
          ],
          8,
        ),
        L.text(inner, input.versionLine, muted(10), 0),
      ],
      { borderWidth: 2 },
    );

    // -- Uncalibrated note as a badge (sample: .uncalibrated-note). --
    if (input.uncalibratedNote.trim()) {
      L.flow([L.callout(w, input.uncalibratedNote)]);
    }

    // -- Build + land (sample: .hero-sub). Build card carries the brass
    //    highlight; land is one fixed figure, never a range. --
    const colInner = (w - 12) / 2 - 40;
    const buildAtoms: Atom[] = [
      L.eyebrow(colInner, reportCopy.buildLabel),
      L.figure(colInner, formatWholeCad(snap.buildRange.base)),
      L.text(colInner, reportCopy.buildCostNote, muted(9.5), 6),
    ];
    if (!isReno && snap.inputs.sqft > 0) {
      const perSqft = formatCentsToCad(dollarsToCents(snap.buildRange.base / snap.inputs.sqft));
      buildAtoms.push(
        L.mixed(
          colInner,
          [
            {
              text: `${perSqft} ${reportCopy.perSqftUnit} · ${snap.inputs.sqft.toLocaleString('en-CA')} ${reportCopy.adjustUnit}`,
              run: muted(10),
            },
          ],
          6,
        ),
      );
    }
    buildAtoms.push(L.hairline(colInner));
    buildAtoms.push(
      L.mixed(
        colInner,
        [
          { text: `${reportCopy.finishLevelLabel} — `, run: muted(10) },
          { text: this.tierLabel(snap.inputs.tier), run: bodyRun(10, true) },
        ],
        0,
      ),
    );

    if (isReno) {
      L.card(buildAtoms);
      L.flow([L.callout(w, reportCopy.renoPermitNote)]);
    } else {
      L.twoColumn(
        buildAtoms,
        [
          L.eyebrow(colInner, reportCopy.landLabel),
          L.figure(colInner, formatWholeCad(snap.landValue.value)),
          L.text(colInner, reportCopy.landFixedNote, muted(9.5), 0),
        ],
        { fill: THEME.brassWash, border: THEME.brass, borderWidth: 1.5 },
        {},
      );
    }

    // -- Cost breakdown: the same three buckets the on-screen report renders
    //    (shared aggregateCostBuckets helper). Land is its own figure above,
    //    never a breakdown row. --
    const buckets = aggregateCostBuckets(snap.rows);
    if (snap.rows.length > 0) {
      const bAtoms: Atom[] = [L.heading(inner, reportCopy.breakdownTitle), L.bucketBar(inner, buckets)];
      for (const bucket of buckets) {
        bAtoms.push(L.bucketRow(inner, bucket));
      }
      L.card(bAtoms);
    }

    // -- Narrative (or its honest absence — never invented). When every model
    //    failed the snapshot carries the static Calgary guide labeled
    //    'static-guide': render it under its own honest title. --
    const isStaticGuide = snap.narrativeSource === 'static-guide';
    const nAtoms: Atom[] = [
      L.heading(inner, isStaticGuide ? reportCopy.staticGuideTitle : reportCopy.narrativeTitle),
    ];
    if (isStaticGuide) {
      nAtoms.push(L.text(inner, reportCopy.staticGuideNote, muted(9.5), 8));
    }
    const narrative = snap.narrative?.trim();
    for (const para of (narrative || reportCopy.pdfNarrativeFallback).split('\n')) {
      const t = para.trim();
      if (t) nAtoms.push(L.text(inner, t, bodyRun(), 8));
    }
    L.card(nAtoms);

    // -- What's not in this estimate (new-build only). --
    if (!isReno) {
      const eAtoms: Atom[] = [
        L.heading(inner, reportCopy.exclusionsTitle),
        L.text(inner, reportCopy.includedLine, bodyRun(), 8),
      ];
      for (const item of reportCopy.exclusions) {
        eAtoms.push(L.bullet(inner, item));
      }
      L.card(eAtoms);
    }

    // -- Next steps. --
    const sAtoms: Atom[] = [L.heading(inner, reportCopy.stepsTitle)];
    input.steps.forEach((step, idx) => {
      sAtoms.push(L.step(inner, idx + 1, step.title, step.body));
    });
    L.card(sAtoms);

    // -- Disclaimer (sample: .deterministic-note). --
    L.brassRule();
    L.flow([L.text(w, input.disclaimer, muted(8.5), 0)]);

    L.finishPages(input.title);
    return doc.output('blob');
  }
}
