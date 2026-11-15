/**
 * Log-alert query shape guard (#767).
 *
 * A scheduled query rule with `timeAggregation: 'Count'` and no
 * `metricMeasureColumn` makes Azure Monitor count the query's result ROWS.
 * A query ending in `| summarize count()` always returns exactly one row —
 * even when nothing matched — so a `> 0` rule fires on every evaluation and
 * a `> 2` / `> 5` rule can never fire. That is how `backup-check-probe` paged
 * nonstop while `http5xx`, `timer-schedule-monitor` and
 * `email-send-failures` were dead.
 *
 * This static test scans every Bicep file under infra/bicep and fails if any
 * scheduled-query criterion ends its query with a `summarize` stage without
 * declaring a `metricMeasureColumn`, or uses a non-Count aggregation without
 * one (Azure rejects/mis-evaluates both).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const BICEP_ROOT = join(__dirname, '..', '..', '..', 'infra', 'bicep');

function bicepFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return bicepFiles(full);
    return name.endsWith('.bicep') ? [full] : [];
  });
}

interface Criterion {
  body: string;
  query: string | undefined;
  timeAggregation: string | undefined;
  metricMeasureColumn: string | undefined;
}

/** Extract each `{ … criterionType: … }` object (brace-balanced) from Bicep source. */
function extractCriteria(source: string): Criterion[] {
  const out: Criterion[] = [];
  const marker = /criterionType\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = marker.exec(source)) !== null) {
    // Walk back to the opening brace of the enclosing object.
    let depth = 0;
    let start = m.index;
    for (; start >= 0; start--) {
      const ch = source[start];
      if (ch === '}') depth++;
      else if (ch === '{') {
        if (depth === 0) break;
        depth--;
      }
    }
    // Walk forward to its matching closing brace.
    depth = 0;
    let end = start;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = source.slice(start, end + 1);
    const prop = (name: string) =>
      new RegExp(`^\\s*${name}\\s*:\\s*'((?:[^'\\\\]|\\\\.|'')*)'`, 'm').exec(body)?.[1];
    out.push({
      body,
      query: prop('query'),
      timeAggregation: prop('timeAggregation'),
      metricMeasureColumn: prop('metricMeasureColumn'),
    });
  }
  return out;
}

/** Returns a problem description, or null when the criterion is well-formed. */
function criterionProblem(c: Criterion): string | null {
  if (c.query === undefined) return null; // metric alert criteria have no query
  const stages = c.query.split('|').map((s) => s.trim());
  const last = stages[stages.length - 1] ?? '';
  const endsInSummarize = /^summarize\b/i.test(last);
  if (!c.metricMeasureColumn) {
    if (endsInSummarize) {
      return `query ends in "${last}" without metricMeasureColumn — Count would count the single summary row`;
    }
    if (c.timeAggregation && c.timeAggregation !== 'Count') {
      return `timeAggregation '${c.timeAggregation}' requires a metricMeasureColumn`;
    }
  }
  return null;
}

describe('scheduled-query alert criteria (#767)', () => {
  const files = bicepFiles(BICEP_ROOT);
  const all = files.flatMap((f) =>
    extractCriteria(readFileSync(f, 'utf8')).map((c) => ({ file: relative(BICEP_ROOT, f), c })),
  );

  it('finds the log-alert criteria (guard is actually scanning something)', () => {
    const withQuery = all.filter(({ c }) => c.query !== undefined);
    expect(withQuery.length).toBeGreaterThanOrEqual(4);
  });

  it('no alert query ends in summarize without a measure column', () => {
    const problems = all
      .map(({ file, c }) => ({ file, query: c.query, problem: criterionProblem(c) }))
      .filter((p) => p.problem !== null);
    expect(problems).toEqual([]);
  });

  it('the four #767 rules count matching rows with Count aggregation', () => {
    const src = readFileSync(join(BICEP_ROOT, 'modules', 'alerts.bicep'), 'utf8');
    const criteria = extractCriteria(src).filter((c) => c.query !== undefined);
    for (const needle of [
      'ResultCode startswith "5"',
      'StorageScheduleMonitor',
      'email.send-failed',
      'backup-check-timer: PROBE FAILED',
    ]) {
      const c = criteria.find((x) => x.query!.includes(needle));
      expect(c, needle).toBeDefined();
      expect(c!.timeAggregation).toBe('Count');
      expect(c!.query).not.toMatch(/summarize/i);
    }
  });

  describe('checker self-test', () => {
    const wrap = (props: string) => `criteria: {\n  allOf: [\n    {\n${props}\n    }\n  ]\n}`;

    it('flags summarize count() with Count and no measure column', () => {
      const [c] = extractCriteria(
        wrap(
          "      criterionType: 'StaticThresholdCriterion'\n" +
            "      query: 'AppTraces | where Message contains \"x\" | summarize count()'\n" +
            "      timeAggregation: 'Count'\n" +
            '      failingPeriods: {\n        numberOfEvaluationPeriods: 1\n      }',
        ),
      );
      expect(criterionProblem(c)).toMatch(/summarize count\(\)/);
    });

    it('accepts summarize count() with metricMeasureColumn + Total', () => {
      const [c] = extractCriteria(
        wrap(
          "      criterionType: 'StaticThresholdCriterion'\n" +
            "      query: 'AppTraces | summarize count()'\n" +
            "      metricMeasureColumn: 'count_'\n" +
            "      timeAggregation: 'Total'",
        ),
      );
      expect(criterionProblem(c)).toBeNull();
    });

    it('accepts a raw-row query with Count', () => {
      const [c] = extractCriteria(
        wrap(
          "      criterionType: 'StaticThresholdCriterion'\n" +
            "      query: 'AppTraces | where Message contains \"x\"'\n" +
            "      timeAggregation: 'Count'",
        ),
      );
      expect(criterionProblem(c)).toBeNull();
    });

    it('flags Total aggregation without a measure column', () => {
      const [c] = extractCriteria(
        wrap(
          "      criterionType: 'StaticThresholdCriterion'\n" +
            "      query: 'AppTraces'\n" +
            "      timeAggregation: 'Total'",
        ),
      );
      expect(criterionProblem(c)).toMatch(/requires a metricMeasureColumn/);
    });
  });
});
