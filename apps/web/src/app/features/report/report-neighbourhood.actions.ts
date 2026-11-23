/**
 * Report "Schools for this address" + "Living near this lot" (#785).
 * One load per address; a repeat for the same address is a no-op.
 */
export class LoadReportNeighbourhood {
  static readonly type = '[Report neighbourhood] Load';
  constructor(public readonly addressKey: string) {}
}
