/**
 * School comparison actions (#781, consumed by the compare page in #782).
 * The list holds school directory ids only — no personal data.
 */
export class ToggleSchoolComparison {
  static readonly type = '[School comparison] Toggle';
  /** `max` comes from config (`limits.schoolComparisonMax`). */
  constructor(
    public readonly schoolId: string,
    public readonly max: number,
  ) {}
}

export class ClearSchoolComparison {
  static readonly type = '[School comparison] Clear';
}
