import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import type { CostRow } from '@feasly/contracts';

import { ConfigService } from '../../core/config/config.service';
import { mockReport } from '../../core/api/mock-data';
import {
  ReportPdfService,
  loadBrandFonts,
  resetBrandFontsForTests,
  sanitizePdfText,
  type ReportPdfInput,
} from './report-pdf.service';

/**
 * ReportPdfService renders the verified snapshot to a real PDF via jsPDF
 * (lazy-loaded), in the sample report page's visual language: cream page,
 * white cards, brass rules, Manrope hero figure, Instrument Sans body.
 * The service owns layout; the component owns the download plumbing and
 * UI states.
 *
 * Text-extraction note: the PDF embeds the brand faces as subset TrueType
 * fonts, so body text is emitted as glyph-ID hex strings (`<0016…> Tj`)
 * decoded through each font's ToUnicode CMap — NOT as WinAnsi literals.
 * The pdfToPages/extractPdfText helpers below decode per font (never a
 * merged glyph map: subset glyph IDs collide across faces). When /fonts is
 * unreachable the service degrades to Helvetica and the same helpers decode
 * the literal WinAnsi strings instead.
 */

const LETTER_WIDTH = 612;
const MARGIN = 44;
const RIGHT_LIMIT = LETTER_WIDTH - MARGIN;

interface PdfTextSegment {
  x: number;
  y: number;
  font: string;
  size: number;
  text: string;
}

function latin1(bytes: Uint8Array): string {
  let raw = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    raw += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return raw;
}

/**
 * Parse the PDF into per-page text segments with their drawn position,
 * font (BaseFont) and size. Decodes custom-font hex runs through the
 * owning font's ToUnicode CMap and Helvetica literals directly.
 */
async function pdfToPages(blob: Blob): Promise<PdfTextSegment[][]> {
  const raw = latin1(new Uint8Array(await blob.arrayBuffer()));

  // Index every indirect object.
  const objects = new Map<number, string>();
  const objRe = /(\d+) 0 obj([\s\S]*?)endobj/g;
  let om: RegExpExecArray | null;
  while ((om = objRe.exec(raw)) !== null) {
    objects.set(Number(om[1]), om[2]);
  }

  // Per-font glyph->unicode maps from each font's own ToUnicode CMap.
  const fontInfo = new Map<number, { baseFont: string; cmap: Map<string, string> }>();
  for (const [num, body] of objects) {
    if (!/\/Type\s*\/Font/.test(body)) continue;
    const baseFont = body.match(/\/BaseFont\s*\/([^\s/>]+)/)?.[1] ?? 'Helvetica';
    const cmap = new Map<string, string>();
    const toUnicodeRef = body.match(/\/ToUnicode\s+(\d+) 0 R/)?.[1];
    const cmapBody = toUnicodeRef ? objects.get(Number(toUnicodeRef)) : undefined;
    if (cmapBody) {
      for (const block of cmapBody.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
        const pairRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
        let pm: RegExpExecArray | null;
        while ((pm = pairRe.exec(block[1])) !== null) {
          let ch = '';
          const dst = pm[2];
          for (let k = 0; k + 4 <= dst.length; k += 4) {
            ch += String.fromCharCode(parseInt(dst.slice(k, k + 4), 16));
          }
          cmap.set(pm[1].toLowerCase(), ch);
        }
      }
    }
    fontInfo.set(num, { baseFont, cmap });
  }

  // jsPDF numbers font resources document-globally (/F1, /F2, …).
  const resourceToObj = new Map<number, number>();
  for (const rm of raw.matchAll(/\/F(\d+)\s+(\d+) 0 R/g)) {
    resourceToObj.set(Number(rm[1]), Number(rm[2]));
  }

  const decodeHex = (hex: string, info?: { cmap: Map<string, string> }): string => {
    const clean = hex.replace(/\s+/g, '').toLowerCase();
    let out = '';
    for (let k = 0; k + 4 <= clean.length; k += 4) {
      out += info?.cmap.get(clean.slice(k, k + 4)) ?? '';
    }
    return out;
  };
  const decodeLiteral = (s: string): string =>
    s.replace(/\\(\d{3}|.)/gs, (_m, code: string) =>
      /^\d{3}$/.test(code) ? String.fromCharCode(parseInt(code, 8)) : code === 'n' ? '\n' : code,
    );

  // Page objects in document order (jsPDF writes them sequentially).
  const pageNums = [...objects]
    .filter(([, body]) => /\/Type\s*\/Page(?!s)/.test(body))
    .map(([num]) => num)
    .sort((a, b) => a - b);

  const tokenRe =
    /\/F(\d+)\s+([\d.]+)\s+Tf|(-?[\d.]+)\s+(-?[\d.]+)\s+Td|\(((?:\\.|[^\\()])*)\)\s*Tj|<([0-9a-fA-F\s]+)>\s*Tj|\[((?:[^\]\\]|\\.)*)\]\s*TJ/g;

  const pages: PdfTextSegment[][] = [];
  for (const pageNum of pageNums) {
    const body = objects.get(pageNum) ?? '';
    const contentsRef = body.match(/\/Contents\s+(\d+) 0 R/)?.[1];
    const streamBody = contentsRef ? objects.get(Number(contentsRef)) : undefined;
    const data = streamBody?.match(/stream\r?\n([\s\S]*?)endstream/)?.[1] ?? '';
    const segs: PdfTextSegment[] = [];

    let fontObj: number | null = null;
    let size = 12;
    let x = 0;
    let y = 0;
    const emit = (text: string): void => {
      if (!text) return;
      const info = fontObj !== null ? fontInfo.get(fontObj) : undefined;
      segs.push({ x, y, font: info?.baseFont ?? 'Helvetica', size, text });
    };

    tokenRe.lastIndex = 0;
    let tm: RegExpExecArray | null;
    while ((tm = tokenRe.exec(data)) !== null) {
      if (tm[1] !== undefined) {
        fontObj = resourceToObj.get(Number(tm[1])) ?? null;
        size = Number(tm[2]);
      } else if (tm[3] !== undefined) {
        x = Number(tm[3]);
        y = Number(tm[4]);
      } else if (tm[5] !== undefined) {
        emit(decodeLiteral(tm[5]));
      } else if (tm[6] !== undefined) {
        const info = fontObj !== null ? fontInfo.get(fontObj) : undefined;
        emit(decodeHex(tm[6], info));
      } else if (tm[7] !== undefined) {
        const info = fontObj !== null ? fontInfo.get(fontObj) : undefined;
        let text = '';
        const elRe = /\(((?:\\.|[^\\()])*)\)|<([0-9a-fA-F\s]+)>/g;
        let em: RegExpExecArray | null;
        while ((em = elRe.exec(tm[7])) !== null) {
          text += em[1] !== undefined ? decodeLiteral(em[1]) : decodeHex(em[2], info);
        }
        emit(text);
      }
    }
    pages.push(segs);
  }
  return pages;
}

/** Decoded text in reading order: pages in order, lines top-to-bottom, runs left-to-right. */
async function extractPdfText(blob: Blob): Promise<string> {
  const pages = await pdfToPages(blob);
  const out: string[] = [];
  for (const segs of pages) {
    const lines = new Map<number, PdfTextSegment[]>();
    for (const s of segs) {
      const key = Math.round(s.y);
      const arr = lines.get(key) ?? [];
      arr.push(s);
      lines.set(key, arr);
    }
    for (const [, arr] of [...lines.entries()].sort((a, b) => b[0] - a[0])) {
      out.push(arr.sort((p, q) => p.x - q.x).map((s) => s.text).join(' '));
    }
  }
  return out.join('\n');
}

/** Collapse all whitespace so assertions don't depend on line wrapping. */
const norm = (s: string): string => s.replace(/\s+/g, ' ');

/** Set the measurer doc to the face a BaseFont names. */
function applyMeasurerFont(measure: jsPDF, baseFont: string): void {
  if (baseFont === 'manrope-bold') measure.setFont('manrope-bold', 'bold');
  else if (baseFont === 'instrumentsans-bold') measure.setFont('instrumentsans-bold', 'normal');
  else if (baseFont === 'instrumentsans') measure.setFont('instrumentsans', 'normal');
  else if (baseFont === 'Helvetica-Bold') measure.setFont('helvetica', 'bold');
  else measure.setFont('helvetica', 'normal');
}

/**
 * Margin regression test (carries PR #424's guarantee on this branch):
 * every drawn text run must end at or before the right margin, measured
 * with the same embedded face the generator used. Catches measure/draw
 * font mismatches and x-positioning bugs in the layout engine.
 */
async function assertNoTextPastRightMargin(blob: Blob): Promise<void> {
  const pages = await pdfToPages(blob);
  const fonts = await loadBrandFonts();
  const measure = new jsPDF({ unit: 'pt', format: 'letter' });
  if (fonts.heading) {
    measure.addFileToVFS('manrope-bold.ttf', fonts.heading);
    measure.addFont('manrope-bold.ttf', 'manrope-bold', 'bold');
  }
  if (fonts.body) {
    measure.addFileToVFS('instrument-sans.ttf', fonts.body);
    measure.addFont('instrument-sans.ttf', 'instrumentsans', 'normal');
  }
  if (fonts.bodyBold) {
    measure.addFileToVFS('instrument-sans-bold.ttf', fonts.bodyBold);
    measure.addFont('instrument-sans-bold.ttf', 'instrumentsans-bold', 'normal');
  }
  const violations: string[] = [];
  for (const segs of pages) {
    for (const s of segs) {
      applyMeasurerFont(measure, s.font);
      measure.setFontSize(s.size);
      const right = s.x + measure.getTextWidth(s.text);
      if (right > RIGHT_LIMIT + 1) {
        violations.push(
          `"${s.text.slice(0, 48)}" x=${s.x.toFixed(1)} w=${measure.getTextWidth(s.text).toFixed(1)} > ${RIGHT_LIMIT}`,
        );
      }
    }
  }
  expect(violations).toEqual([]);
}

describe('ReportPdfService', () => {
  beforeEach(() => {
    // Fresh font state per test: the /fonts fetch outcome must never leak
    // between tests via the module promise cache.
    resetBrandFontsForTests();
  });

  function input(overrides: Partial<ReportPdfInput> = {}): ReportPdfInput {
    const snapshot = mockReport(
      'estimate-1',
      'lead-1',
      { sqft: 2200, tier: 'premium', garage: 'double', basement: 'unfinished' },
      'Dollar figures are calculated deterministically from our cost model — not generated by AI.',
    );
    return {
      snapshot,
      address: '2631 63 Ave SW, Calgary, AB',
      title: 'New-build cost report',
      preparedLine: 'Prepared September 27, 2026',
      versionLine: 'Report version 3',
      steps: [
        { title: 'Meet your matched builder', body: 'We can connect you.' },
        { title: 'Refine your project brief', body: 'Lock in must-haves.' },
      ],
      disclaimer: 'Dollar figures are calculated deterministically from our cost model — not generated by AI.',
      uncalibratedNote: 'Uncalibrated planning figures.',
      ...overrides,
    };
  }

  function reportCopy() {
    return TestBed.inject(ConfigService).get('copy').report;
  }

  it('generates a non-empty PDF blob with the PDF magic bytes', async () => {
    const service = TestBed.inject(ReportPdfService);
    const blob = await service.generate(input());
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBeGreaterThan(1000);
    expect(await blob.slice(0, 5).text()).toBe('%PDF-');
  });

  it('renders the address, version, and headline figures decoded from the PDF content', async () => {
    const service = TestBed.inject(ReportPdfService);
    const text = norm(await extractPdfText(await service.generate(input())));
    const copy = reportCopy();
    expect(text).toContain('2631 63 Ave SW, Calgary, AB');
    expect(text).toContain('Report version 3');
    expect(text).toContain('Feasly');
    expect(text).toContain(copy.totalLabel.toUpperCase());
    expect(text).toContain(copy.planningRangeLabel);
  });

  it('renders the honest empty-narrative fallback instead of inventing text', async () => {
    const service = TestBed.inject(ReportPdfService);
    const empty = input();
    const text = norm(
      await extractPdfText(
        await service.generate({
          ...empty,
          snapshot: { ...empty.snapshot, narrative: '   ' },
        }),
      ),
    );
    expect(text).toContain('the figures above are the complete estimate');
  });

  it('includes the coverage framing and the landscaping-only exclusion', async () => {
    const service = TestBed.inject(ReportPdfService);
    const text = norm(await extractPdfText(await service.generate(input())));
    expect(text).toContain('60+ line items');
    expect(text).toContain("What's not in this estimate");
    // Landscaping is the only exclusion (Karan 2026-09-28).
    expect(text).toContain('Landscaping');
    expect(text).not.toContain('Demolition of any existing home');
    expect(text).not.toContain('Financing costs');
  });

  it('omits the new-build exclusions on a renovation snapshot', async () => {
    const service = TestBed.inject(ReportPdfService);
    const renoInput = input();
    const text = norm(
      await extractPdfText(
        await service.generate({
          ...renoInput,
          title: 'Renovation estimate',
          snapshot: { ...renoInput.snapshot, projectType: 'renovation' as const },
        }),
      ),
    );
    // New-build coverage framing must not leak onto reno PDFs.
    expect(text).toContain('Permit and contingency allowances are estimates');
    expect(text).not.toContain('60+ line items');
    expect(text).not.toContain("What's not in this estimate");
    expect(text).not.toContain('Demolition of any existing home');
  });

  it('strips unencodable characters so no UTF-16BE (NUL-interleaved) text is emitted', async () => {
    const service = TestBed.inject(ReportPdfService);
    const dirty = input();
    const blob = await service.generate({
      ...dirty,
      snapshot: {
        ...dirty.snapshot,
        // The real triggers (jsPDF 4.2.1 trigger matrix): U+200B/U+2028
        // (which LLMs emit) flip the whole line to UTF-16BE
        // (NUL-interleaved) and the line renders ~2x too wide, clipped at
        // the page edge. C0 controls like \x11 have no WinAnsi glyph either.
        narrative:
          'Sunalta is a well\u200b-established\u200b\u2028inner city neighbourhood.\x11\x0BFees are calculated deterministically — no surprises…',
      },
    });
    // Raw bytes: no NUL anywhere (UTF-16BE would interleave them).
    expect(latin1(new Uint8Array(await blob.arrayBuffer()))).not.toContain('\x00');
    // Decoded text: words intact after stripping; WinAnsi punctuation kept.
    const text = norm(await extractPdfText(blob));
    expect(text).toContain('Sunalta is a well-establishedinner city neighbourhood.');
    expect(text).toContain('Fees are calculated deterministically');
    expect(text).toContain('no surprises');
  });

  it('renders the same three cost buckets as the report page, land excluded', async () => {
    const service = TestBed.inject(ReportPdfService);
    // The 10 raw engine rows of a real snapshot, including the land row that
    // the PDF used to dump verbatim (QA bug: breakdown did not match the page).
    const rows: CostRow[] = [
      { key: 'land', label: 'Land (assessed value)', range: { low: 4930000, base: 4930000, high: 4930000 } },
      { key: 'hard.framing', label: 'Framing & structure', range: { low: 80000, base: 90000, high: 100000 } },
      { key: 'hard.foundation', label: 'Foundation', range: { low: 59000, base: 66000, high: 73000 } },
      { key: 'hard.envelope', label: 'Envelope (roof, siding, windows)', range: { low: 65000, base: 72000, high: 79000 } },
      { key: 'hard.sitePrep', label: 'Site preparation & excavation', range: { low: 41000, base: 46000, high: 51000 } },
      { key: 'hard.finishes', label: 'Interior finishes', range: { low: 108000, base: 120000, high: 132000 } },
      { key: 'hard.mep', label: 'Mechanical, electrical & plumbing', range: { low: 61000, base: 68000, high: 75000 } },
      { key: 'soft.design', label: 'Design & engineering', range: { low: 23000, base: 26000, high: 29000 } },
      { key: 'soft.permits', label: 'Permits & fees', range: { low: 5000, base: 7000, high: 9000 } },
      { key: 'contingency', label: 'Contingency', range: { low: 52000, base: 52803, high: 52803 } },
    ];
    const bucketed = input();
    const text = norm(
      await extractPdfText(
        await service.generate({
          ...bucketed,
          snapshot: { ...bucketed.snapshot, rows },
        }),
      ),
    );
    // Exactly the three bucket labels the report page renders.
    expect(text).toContain('Structure & exterior');
    expect(text).toContain('Interior & home systems');
    expect(text).toContain('Design, permits & contingency');
    // Each bucket's base figure, summed from the raw rows (land excluded).
    expect(text).toContain('$274,000'); // 90k+66k+72k+46k
    expect(text).toContain('$188,000'); // 120k+68k
    expect(text).toContain('$85,803'); // 26k+7k+52,803
    // No per-row dump, and no land breakdown row duplicating the summary's.
    expect(text).not.toContain('Land (assessed value)');
    expect(text).not.toContain('Framing & structure');
    expect(text).not.toContain('Interior finishes');
    // Land keeps its own fixed figure via the shared land label (eyebrows
    // render uppercased, like the sample report page's text-transform).
    expect(text).toContain(reportCopy().landLabel.toUpperCase());
  });

  it('keeps every text run inside the right margin (PR #424 guarantee)', async () => {
    const service = TestBed.inject(ReportPdfService);
    const base = input();
    // Full narrative + control chars: the widest, most hostile content.
    const hostile = await service.generate({
      ...base,
      snapshot: {
        ...base.snapshot,
        narrative:
          'Sunalta is a well\u200b-established\u200b\u2028inner city neighbourhood with mature trees.\x11\x0B '.repeat(
            12,
          ),
      },
    });
    await assertNoTextPastRightMargin(hostile);
    // Empty narrative (fallback path) on a second page-heavy layout.
    const fallback = await service.generate({
      ...base,
      snapshot: { ...base.snapshot, narrative: '   ' },
    });
    await assertNoTextPastRightMargin(fallback);
  });

  it('paints the sample-report brand tokens: cream page, brass accents', async () => {
    const service = TestBed.inject(ReportPdfService);
    const raw = latin1(new Uint8Array(await (await service.generate(input())).arrayBuffer()));
    // Page background #f7f4ef, brass #a8761a (jsPDF rounds to 2 decimals).
    expect(raw).toContain('0.97 0.96 0.94 rg');
    expect(raw).toContain('0.66 0.46 0.1');
  });

  it('embeds the brand faces when /fonts serves them, else degrades to Helvetica', async () => {
    const service = TestBed.inject(ReportPdfService);
    const fonts = await loadBrandFonts();
    const raw = latin1(new Uint8Array(await (await service.generate(input())).arrayBuffer()));
    if (fonts.heading && fonts.body && fonts.bodyBold) {
      expect(raw).toContain('/manrope-bold');
      expect(raw).toContain('/instrumentsans');
    } else {
      // /fonts is not served in the unit-test runner: the PDF must still
      // generate, fully readable, in the Helvetica fallback.
      expect(raw).toContain('Helvetica');
      expect(raw).not.toContain('/manrope-bold');
      const text = norm(await extractPdfText(await service.generate(input())));
      expect(text).toContain('2631 63 Ave SW, Calgary, AB');
    }
  });

  it('still generates a complete PDF when the font fetch fails outright', async () => {
    const service = TestBed.inject(ReportPdfService);
    resetBrandFontsForTests();
    vi.stubGlobal(
      'fetch',
      () => Promise.reject(new Error('offline')),
    );
    try {
      const blob = await service.generate(input());
      const raw = latin1(new Uint8Array(await blob.arrayBuffer()));
      expect(raw).toContain('Helvetica');
      expect(raw).not.toContain('/manrope-bold');
      const text = norm(await extractPdfText(blob));
      expect(text).toContain('TOTAL INVESTMENT');
      await assertNoTextPastRightMargin(blob);
    } finally {
      vi.unstubAllGlobals();
      resetBrandFontsForTests();
    }
  });
});

describe('sanitizePdfText', () => {
  it('strips C0 controls, DEL and C1 controls but preserves newlines and tabs', () => {
    expect(sanitizePdfText('a\x11b\x00c\x7Fde')).toBe('abcde');
    expect(sanitizePdfText('line1\nline2\tline3')).toBe('line1\nline2\tline3');
    expect(sanitizePdfText('plain text')).toBe('plain text');
  });

  it('strips unmapped >U+00FF chars that would flip jsPDF to UTF-16BE, keeps WinAnsi-mapped punctuation', () => {
    // U+200B / U+2028 (LLM favourites) flip the whole line to UTF-16BE.
    expect(sanitizePdfText('a\u200bb\u2028c')).toBe('abc');
    // cp1252-mapped punctuation renders fine in WinAnsi — keep it.
    expect(sanitizePdfText('em—dash ‘quote’ “double” ellipsis…')).toBe(
      'em—dash ‘quote’ “double” ellipsis…',
    );
    // Surrogate-pair emoji would also flip the line — drop it.
    expect(sanitizePdfText('hi 😀 bye')).toBe('hi  bye');
  });
});
