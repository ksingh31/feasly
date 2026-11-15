/** MoneyStrip severity tiering. Pure — no Angular. */
import type { StatusTone } from '../status/status-dictionary';

export interface MoneyStripItem {
  /** Display-ready fragment, e.g. "1 card failed" or "$19,800 charges tonight". */
  readonly text: string;
  readonly tone: StatusTone;
}

/** Most severe first. Paused (disputed) outranks routine info. */
const SEVERITY: readonly StatusTone[] = [
  'danger',
  'warning',
  'paused',
  'progress',
  'info',
  'success',
  'neutral',
];

function rank(tone: StatusTone): number {
  const index = SEVERITY.indexOf(tone);
  return index < 0 ? SEVERITY.length : index;
}

/** Items ordered most severe first; ties keep input order. */
export function tierMoneyStripItems(items: readonly MoneyStripItem[]): MoneyStripItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.tone) - rank(b.item.tone) || a.index - b.index)
    .map(({ item }) => item);
}

/** The strip's tone: its most severe item, neutral when empty. */
export function moneyStripTone(items: readonly MoneyStripItem[]): StatusTone {
  return tierMoneyStripItems(items)[0]?.tone ?? 'neutral';
}
