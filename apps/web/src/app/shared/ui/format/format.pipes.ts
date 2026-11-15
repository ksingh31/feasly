/**
 * Portal formatting pipes (portal-ui-kit §3). Thin, pure wrappers over the
 * shared utils so templates never format by hand. None of them output
 * seconds or a raw ISO string; null/invalid input renders '—'.
 *
 * Names carry a `kit` prefix so they never collide with Angular's
 * CommonModule `date` pipe.
 */
import { Pipe, type PipeTransform } from '@angular/core';
import { formatRelativeTime } from '../../utils/datetime';
import { formatEdmontonDateTime, formatEdmontonMediumDate } from '../../utils/edmonton';
import { formatCentsToWholeCad, formatCount, formatWholeCad } from '../../utils/money';

/** ISO instant → "Nov 12, 2026" (America/Edmonton calendar). */
@Pipe({ name: 'kitDate', standalone: true })
export class KitDatePipe implements PipeTransform {
  transform(iso: string | null | undefined): string {
    return formatEdmontonMediumDate(iso ?? null);
  }
}

/** ISO instant → "Nov 12, 2026 · 11:30 a.m. MT". */
@Pipe({ name: 'kitDateTime', standalone: true })
export class KitDateTimePipe implements PipeTransform {
  transform(iso: string | null | undefined): string {
    return formatEdmontonDateTime(iso ?? null);
  }
}

/**
 * ISO instant → "2 days ago". Pair with `[title]="x | kitDateTime"` for the
 * absolute value on hover. Pure: recomputes when the input (or `now`)
 * changes, not on a clock.
 */
@Pipe({ name: 'kitRelative', standalone: true })
export class KitRelativePipe implements PipeTransform {
  transform(iso: string | null | undefined, now?: Date): string {
    return formatRelativeTime(iso ?? null, now);
  }
}

/** Whole-dollar money. Input is integer cents unless `unit` is 'dollars'. */
@Pipe({ name: 'kitMoney', standalone: true })
export class KitMoneyPipe implements PipeTransform {
  transform(value: number | null | undefined, unit: 'cents' | 'dollars' = 'cents'): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return '—';
    }
    return unit === 'dollars' ? formatWholeCad(value) : formatCentsToWholeCad(value);
  }
}

/** Count with thousands separators: 1843 → "1,843". */
@Pipe({ name: 'kitCount', standalone: true })
export class KitCountPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      return '—';
    }
    return formatCount(value);
  }
}

/** Every kit pipe, for `imports: [...KIT_FORMAT_PIPES]`. */
export const KIT_FORMAT_PIPES = [
  KitDatePipe,
  KitDateTimePipe,
  KitRelativePipe,
  KitMoneyPipe,
  KitCountPipe,
] as const;
