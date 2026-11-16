import { callbackDayOptions, formatCallbackDay } from './callback-day';

describe('callback-day (#836)', () => {
  // 2026-11-16T05:00Z = Sun 2026-11-15 22:00 in America/Edmonton.
  const NOW = new Date('2026-11-16T05:00:00Z');

  it('lists weekdays from tomorrow through the window on the Edmonton calendar', () => {
    const options = callbackDayOptions(14, NOW);
    expect(options.map((o) => o.value)).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      '2026-11-26',
      '2026-11-27',
    ]);
    expect(options[0]?.label).toBe('Monday, Nov 16');
  });

  it('never offers today or a weekend', () => {
    const friday = new Date('2026-11-20T18:00:00Z'); // Fri 11:00 MT
    const values = callbackDayOptions(3, friday).map((o) => o.value);
    expect(values).toEqual(['2026-11-23']);
  });

  it('formats a stored day and tolerates missing or malformed keys', () => {
    expect(formatCallbackDay('2026-11-18')).toBe('Wednesday, Nov 18');
    expect(formatCallbackDay(null)).toBeNull();
    expect(formatCallbackDay('soon')).toBeNull();
  });
});
