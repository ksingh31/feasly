/**
 * Stepper models (portal-ui-kit §3): lead status (New → Contacted → Quoted
 * → Won/Lost) and invoice lifecycle (Issued → Review window → Charged →
 * Paid). Pure presentation mapping — no Angular, no business rules.
 */
import {
  type StatusTone,
  statusPresentation,
} from '../status/status-dictionary';

export interface StepperStep {
  readonly key: string;
  readonly label: string;
}

export type StepState = 'complete' | 'current' | 'upcoming';

export interface StepperModel {
  readonly steps: readonly StepperStep[];
  /** Key of the current step; null → nothing started (all upcoming). */
  readonly current: string | null;
  /** Tone of the current step's marker. */
  readonly tone: StatusTone;
  /** Replaces the current step's label (e.g. "Lost", "Charge failed"). */
  readonly currentLabel?: string;
}

/** Each step's state given the current key. Unknown key → all upcoming. */
export function stepStates(steps: readonly StepperStep[], current: string | null): StepState[] {
  const at = current === null ? -1 : steps.findIndex((s) => s.key === current);
  return steps.map((_, i) => (at < 0 || i > at ? 'upcoming' : i === at ? 'current' : 'complete'));
}

export const LEAD_STEPS: readonly StepperStep[] = [
  { key: 'new', label: 'New' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'quoted', label: 'Quoted' },
  { key: 'outcome', label: 'Won/Lost' },
];

/** Lead stepper from an admin (`quoting`) or builder (`quoted`) status. */
export function leadStepperModel(status: string | null | undefined): StepperModel {
  const tone = statusPresentation('lead', status).tone;
  switch (status) {
    case 'new':
    case 'contacted':
      return { steps: LEAD_STEPS, current: status, tone };
    case 'quoting':
    case 'quoted':
      return { steps: LEAD_STEPS, current: 'quoted', tone };
    case 'won':
    case 'lost':
      return {
        steps: LEAD_STEPS,
        current: 'outcome',
        tone,
        currentLabel: statusPresentation('lead', status).label,
      };
    default:
      return { steps: LEAD_STEPS, current: null, tone: 'neutral' };
  }
}

export const INVOICE_STEPS: readonly StepperStep[] = [
  { key: 'issued', label: 'Issued' },
  { key: 'review', label: 'Review window' },
  { key: 'charged', label: 'Charged' },
  { key: 'paid', label: 'Paid' },
];

/**
 * Invoice lifecycle from a commission-invoice status. Drafts are not issued
 * yet (all upcoming); a dispute pauses the review window; a failed charge
 * marks the charge step as danger; void stops at Issued.
 */
export function invoiceStepperModel(status: string | null | undefined): StepperModel {
  const { tone, label } = statusPresentation('invoice', status);
  switch (status) {
    case 'in_review':
      return { steps: INVOICE_STEPS, current: 'review', tone };
    case 'disputed':
      return { steps: INVOICE_STEPS, current: 'review', tone, currentLabel: label };
    case 'finalized':
      return { steps: INVOICE_STEPS, current: 'charged', tone };
    case 'failed':
      return { steps: INVOICE_STEPS, current: 'charged', tone, currentLabel: 'Charge failed' };
    case 'paid':
      return { steps: INVOICE_STEPS, current: 'paid', tone };
    case 'void':
      return { steps: INVOICE_STEPS, current: 'issued', tone, currentLabel: label };
    default:
      return { steps: INVOICE_STEPS, current: null, tone: 'neutral' };
  }
}
