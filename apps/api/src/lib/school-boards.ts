/**
 * School boards that publish designations (#775) — pure constants.
 *
 * Shared by the refresh side (provider, review issue) and the request side
 * (read service), so the read path never imports provider code. No I/O.
 */
import type { SchoolBoardId } from '@feasly/contracts';

/** Display name per board. */
export const SCHOOL_BOARD_NAMES: Readonly<Record<SchoolBoardId, string>> = {
  cbe: 'Calgary Board of Education',
  ccsd: 'Calgary Catholic School District',
};

/** Copy guard (epic rules: "typically designated", "confirm with the board"). */
export const SCHOOL_DESIGNATIONS_DISCLAIMER =
  'These are the schools typically designated for this community. Designations can differ ' +
  'by address and change from year to year, so confirm with the board using its address lookup.';
