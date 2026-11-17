/**
 * School designations (#775) — pure helpers, no I/O.
 *
 * CBE and CCSD publish their designated schools by community (designation
 * maps and notices); there is no open boundary file. The `board-published`
 * provider turns a curated list transcribed from those notices
 * (`school-designations.data.ts`) into one record per community, board and
 * grade band. The monthly refresh compares each new snapshot with the stored
 * one (`diffDesignations`) so a changed designation can be sent for review.
 */
import {
  DESIGNATION_GRADE_BANDS,
  SCHOOL_BOARD_IDS,
  type DesignationGradeBand,
  type SchoolBoardId,
} from '@feasly/contracts';
import { SCHOOL_BOARD_NAMES } from '../../lib/school-boards';
import { toSlug } from '../community-stats/socrata-aggregates';
import type { SchoolDesignationRecord } from './providers';

/** One designation as a board publishes it (one curated list entry). */
export interface CuratedDesignation {
  /** City community code, e.g. 'ALT'. Established communities only (#690). */
  readonly communityCode: string;
  /** City community name, e.g. 'Altadore'. */
  readonly communityName: string;
  readonly board: SchoolBoardId;
  readonly gradeBand: DesignationGradeBand;
  /** The designated school as the board names it. */
  readonly schoolName: string;
  /** The board notice or map this entry was transcribed from. */
  readonly sourceUrl?: string;
  /** School year the notice applies to, e.g. '2026-27'. */
  readonly schoolYear?: string;
}

/** A curated entry failed validation — fails the refresh (keeps the old data). */
export class InvalidDesignationError extends Error {
  constructor(index: number, reason: string) {
    super(`school designation entry ${index}: ${reason}`);
    this.name = 'InvalidDesignationError';
  }
}

const COMMUNITY_CODE_RE = /^[A-Z0-9]{2,5}$/;

/** Stable record key: one designation per community, board and grade band. */
export function designationKey(board: string, communityCode: string, gradeBand: string): string {
  return `${board}|${communityCode}|${gradeBand}`.toLowerCase();
}

/**
 * Curated entries → designation records. Throws on an invalid or duplicated
 * entry: a half-valid list would silently drop designations.
 */
export function buildDesignationRecords(
  entries: readonly CuratedDesignation[],
): SchoolDesignationRecord[] {
  const seen = new Set<string>();
  return entries.map((entry, i) => {
    const communityCode = entry.communityCode.trim().toUpperCase();
    const communityName = entry.communityName.trim();
    const schoolName = entry.schoolName.trim();
    if (!COMMUNITY_CODE_RE.test(communityCode)) throw new InvalidDesignationError(i, 'bad community code');
    if (!communityName) throw new InvalidDesignationError(i, 'missing community name');
    if (!schoolName) throw new InvalidDesignationError(i, 'missing school name');
    if (!SCHOOL_BOARD_IDS.includes(entry.board)) throw new InvalidDesignationError(i, 'unknown board');
    if (!DESIGNATION_GRADE_BANDS.includes(entry.gradeBand)) {
      throw new InvalidDesignationError(i, 'unknown grade band');
    }
    const externalId = designationKey(entry.board, communityCode, entry.gradeBand);
    if (seen.has(externalId)) throw new InvalidDesignationError(i, `duplicate ${externalId}`);
    seen.add(externalId);
    return {
      externalId,
      communityCode,
      schoolRef: null,
      gradeBand: entry.gradeBand,
      data: {
        board: entry.board,
        boardName: SCHOOL_BOARD_NAMES[entry.board],
        schoolName,
        communityName,
        slug: toSlug(communityName),
        sourceUrl: entry.sourceUrl ?? null,
        schoolYear: entry.schoolYear ?? null,
      },
    };
  });
}

/** A stored designation, as the diff needs it. */
export interface DesignationSnapshotRow {
  readonly externalId: string;
  readonly communityCode?: string | null;
  readonly gradeBand: string | null;
  readonly data: unknown;
}

/** One designation that differs between the stored and the new snapshot. */
export interface DesignationChange {
  readonly key: string;
  readonly kind: 'added' | 'removed' | 'changed';
  readonly communityCode: string;
  readonly communityName: string;
  readonly board: string;
  readonly gradeBand: string;
  /** School before (null when added). */
  readonly before: string | null;
  /** School after (null when removed). */
  readonly after: string | null;
}

function field(data: unknown, key: string): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** School names compare case- and whitespace-insensitively. */
function sameSchool(a: string | null, b: string | null): boolean {
  const norm = (v: string | null) => (v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}

function describe(row: DesignationSnapshotRow): Omit<DesignationChange, 'kind' | 'before' | 'after'> {
  const [board = '', , band = ''] = row.externalId.split('|');
  return {
    key: row.externalId,
    communityCode: row.communityCode ?? '',
    communityName: field(row.data, 'communityName') ?? row.communityCode ?? '',
    board: field(row.data, 'board') ?? board,
    gradeBand: row.gradeBand ?? band.toUpperCase(),
  };
}

/**
 * What changed between the stored snapshot and the new one. An empty stored
 * snapshot (first load) is not a change. Sorted by key (stable issue text).
 */
export function diffDesignations(
  previous: readonly DesignationSnapshotRow[],
  next: readonly DesignationSnapshotRow[],
): DesignationChange[] {
  if (previous.length === 0) return [];
  const before = new Map(previous.map((row) => [row.externalId, row]));
  const after = new Map(next.map((row) => [row.externalId, row]));
  const changes: DesignationChange[] = [];
  for (const [key, row] of after) {
    const old = before.get(key);
    const school = field(row.data, 'schoolName');
    if (!old) {
      changes.push({ ...describe(row), kind: 'added', before: null, after: school });
    } else if (!sameSchool(field(old.data, 'schoolName'), school)) {
      changes.push({ ...describe(row), kind: 'changed', before: field(old.data, 'schoolName'), after: school });
    }
  }
  for (const [key, row] of before) {
    if (!after.has(key)) {
      changes.push({ ...describe(row), kind: 'removed', before: field(row.data, 'schoolName'), after: null });
    }
  }
  return changes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
