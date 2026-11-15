/**
 * Minimal single-page PDF writer (#661 invoice PDF/receipt download).
 *
 * Pure: no I/O, no clock, no env — the same input always produces the
 * same bytes. Deliberately tiny instead of a PDF library: the invoice is
 * a handful of text lines and rules, and a dependency would bloat the
 * shared Functions closure (tools/check-function-bundle.mjs budget).
 *
 * Text uses the PDF standard-14 Helvetica faces with WinAnsiEncoding, so
 * no font is embedded. Characters outside WinAnsi are replaced with '?'
 * (common typographic punctuation is mapped to its cp1252 byte first).
 * Coordinates are PDF points with the origin at the TOP-left (the writer
 * flips y), US Letter by default.
 */

export interface PdfTextOp {
  readonly kind: 'text';
  readonly x: number;
  /** Baseline distance from the TOP of the page, in points. */
  readonly y: number;
  readonly size: number;
  readonly bold?: boolean;
  readonly text: string;
}

export interface PdfRuleOp {
  readonly kind: 'rule';
  readonly x1: number;
  readonly x2: number;
  /** Distance from the TOP of the page, in points. */
  readonly y: number;
  readonly width?: number;
}

export type PdfOp = PdfTextOp | PdfRuleOp;

export interface PdfPageSpec {
  readonly widthPt?: number;
  readonly heightPt?: number;
  readonly title?: string;
  readonly ops: readonly PdfOp[];
}

/** US Letter, in points. */
export const PDF_LETTER = { widthPt: 612, heightPt: 792 } as const;

/** Unicode → cp1252 byte for the WinAnsi extras above U+00FF. */
const CP1252_EXTRAS: Readonly<Record<string, number>> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86,
  '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
  'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95,
  '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
  'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

/**
 * Encodes text as WinAnsi bytes (one char per byte, as a latin1 string)
 * and escapes it for a PDF literal string.
 */
export function encodePdfText(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0x3f;
    let byte: number;
    if (code === 0x0a || code === 0x0d || code === 0x09) byte = 0x20;
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) byte = code;
    else byte = CP1252_EXTRAS[ch] ?? 0x3f;
    const c = String.fromCharCode(byte);
    out += c === '\\' || c === '(' || c === ')' ? `\\${c}` : c;
  }
  return out;
}

/** Fixed-precision number for content streams (no float dust). */
function num(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function contentStream(ops: readonly PdfOp[], heightPt: number): string {
  const lines: string[] = [];
  for (const op of ops) {
    if (op.kind === 'text') {
      const font = op.bold ? '/F2' : '/F1';
      lines.push(
        `BT ${font} ${num(op.size)} Tf ${num(op.x)} ${num(heightPt - op.y)} Td (${encodePdfText(op.text)}) Tj ET`,
      );
    } else {
      const y = num(heightPt - op.y);
      lines.push(
        `${num(op.width ?? 0.75)} w ${num(op.x1)} ${y} m ${num(op.x2)} ${y} l S`,
      );
    }
  }
  return lines.join('\n');
}

/** Renders one page to a complete PDF 1.4 file. */
export function renderPdf(spec: PdfPageSpec): Buffer {
  const widthPt = spec.widthPt ?? PDF_LETTER.widthPt;
  const heightPt = spec.heightPt ?? PDF_LETTER.heightPt;
  const stream = contentStream(spec.ops, heightPt);

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(widthPt)} ${num(heightPt)}] ` +
      '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    `<< /Title (${encodePdfText(spec.title ?? '')}) /Producer (Feasly) >>`,
  ];

  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  const size = objects.length + 1;
  body += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${size} /Root 1 0 R /Info ${objects.length} 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
