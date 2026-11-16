/**
 * Typed application configuration.
 *
 * Everything tunable lives here — never as literals in components or services.
 * The JSON file at `/assets/config/app-config.json` is deep-merged over
 * {@link DEFAULT_APP_CONFIG} at startup (see ConfigService), so any key may be
 * omitted there and the compiled default applies.
 *
 * FE1-001+ will extend the `copy` section with page-level strings.
 */
import type { DataFreshnessCopy } from '../data-freshness/data-freshness';
import type {
  BasementOption,
  CallbackWindow,
  FinishTier,
  GarageOption,
  TimelineOption,
  WaitlistTopic,
} from '@feasly/contracts';

/**
 * One trust-strip stat block on the landing page: a big display value with a
 * small supporting label underneath.
 * - `valueShort`: optional compact value shown on narrow screens
 *   (e.g. "Sep 2026" instead of "September 2026"); falls back to `value`.
 * - `badge`: renders a brass check badge above the value instead of the
 *   large display number (for non-numeric stats like "Same fixed formula").
 * - `key`: runtime-rewritten items. The item with
 *   `key: 'city-data-freshness'` is rewritten at runtime into the shared
 *   freshness line (`copy.dataFreshness`, #513) from
 *   GET /api/v1/city-data/freshness: value "2026 assessment roll", label
 *   "(City of Calgary) · checked Nov 2026" — the same string the property
 *   card shows. While neither the roll year nor the month is known the item
 *   keeps its configured `value`/`label` fallback — never a hardcoded
 *   year or month that goes stale.
 */
export interface TrustStat {
  value: string;
  valueShort?: string;
  label: string;
  badge?: boolean;
  /** Stable key for items the page rewrites at runtime. */
  key?: string;
}

/** Builder Entra tenant wiring (infrastructure config — needed at root). */
export interface BuilderEntraConfig {
    /** Builder Entra tenant subdomain ({sub}.ciamlogin.com). */
    tenantSubdomain: string;
    /** Builder Entra tenant (directory) ID. */
    tenantId: string;
    /** Builder Entra app (client) ID. */
    clientId: string;
    /** Builder Entra user flow / policy name. */
    userFlow: string;
    /**
     * OAuth2 authorize endpoint template; {tenantSubdomain} and
     * {tenantId} are interpolated at runtime.
     */
    authorizeUrlTemplate: string;
}

/**
 * User-facing builder-portal copy. Lazy-loaded with the builder portal
 * (features/builder/builder-copy.defaults.ts, provided as BUILDER_COPY)
 * so the initial bundle doesn't carry it.
 */
export interface BuilderCopy {
  loginHeading: string;
  loginExpired: string;
  emailInvalid: string;
  retryLabel: string;
  shellBrand: string;
  shellNavDashboard: string;
  signOutLabel: string;
  dashboardHeading: string;
  loadingLeads: string;
  loadError: string;
  emptyLeads: string;
  filterLabel: string;
  filterAllLabel: string;
  emptyFilterLeads: string;
  summaryHeading: string;
  summaryTotal: string;
  statusLabels: {
      new: string;
      contacted: string;
      quoted: string;
      won: string;
      lost: string;
  };
  updateForbidden: string;
  updateFailed: string;
  leadEmailLabel: string;
  leadAddressLabel: string;
  leadPhoneLabel: string;
  leadTimelineLabel: string;
  leadScoreLabel: string;
  leadProjectLabel: string;
  leadCreatedLabel: string;
  leadStatusUpdatedLabel: string;
  actionsLabel: string;
  shellNavBilling: string;
  shellNavInvoices: string;
  shellNavReportContract: string;
  reportContractSeoDescription: string;
  reportContractHeading: string;
  reportContractExplainer: string;
  reportContractLeadLabel: string;
  reportContractLeadRequired: string;
  reportContractLeadsLoading: string;
  reportContractLeadsError: string;
  reportContractLeadsEmpty: string;
  recordContractNoReportableLeads: string;
  recordContractAlreadyRecordedTitle: string;
  recordContractAlreadyRecordedBody: string;
  reportContractValueLabel: string;
  reportContractValueHint: string;
  reportContractValueRequired: string;
  reportContractValueInvalid: string;
  reportContractDateLabel: string;
  reportContractDateRequired: string;
  reportContractDateFuture: string;
  reportContractSubmit: string;
  reportContractSubmitting: string;
  reportContractSuccessTitle: string;
  reportContractSuccessBody: string;
  /**
   * Manual-method variant (QA 2026-10-04): the minted invoice snapshots
   * the org's default payment method — a cheque-default builder must
   * never see a card-charge promise. {method} = lowercased method label.
   */
  reportContractSuccessBodyManual: string;
  reportContractAlreadyReported: string;
  reportContractDisputed: string;
  reportContractFlatCovered: string;
  reportContractNotEnabled: string;
  reportContractAwaitingDetails: string;
  recordContractViewInvoice: string;
  recordContractBackToLeads: string;
  recordContractReviewDeadline: string;
  recordContractAutoCharge: string;
  recordContractZeroCommission: string;
  billingHeading: string;
  billingLoading: string;
  billingLoadError: string;
  billingNoCard: string;
  billingCardOnFile: string;
  billingAddCard: string;
  billingUpdateCard: string;
  billingFormHeading: string;
  billingSaveCard: string;
  billingSavingCard: string;
  billingCardSaved: string;
  billingSaveFailed: string;
  billingCancel: string;
  billingExplainer: string;
  billingDefaultMethodTitle: string;
  billingDefaultMethodHelper: string;
  billingDefaultMethodLabel: string;
  billingDefaultMethodSaved: string;
  billingDefaultMethodSaveFailed: string;
  billingDefaultMethodApply: string;
  billingDefaultMethodApplying: string;
  billingDefaultMethodReset: string;
  billingMethodCard: string;
  billingMethodCardWithLast4: string;
  billingMethodCardNoCard: string;
  billingMethodCheque: string;
  billingMethodETransfer: string;
  billingMethodBankDraft: string;
  invoicesHeading: string;
  invoicesExplainer: string;
  invoicesLoading: string;
  invoicesLoadError: string;
  invoicesEmpty: string;
  invoicesColDate: string;
  invoicesColInvoiceNumber: string;
  invoicesColContract: string;
  invoicesColCommission: string;
  invoicesColStatus: string;
  invoicesColDue: string;
  invoicesColMethod: string;
  invoicesColLead: string;
  invoiceStatusDraft: string;
  invoiceStatusInReview: string;
  invoiceStatusFinalized: string;
  invoiceStatusPaid: string;
  invoiceStatusFailed: string;
  invoiceStatusDisputed: string;
  invoiceStatusVoid: string;
  invoicesAutoChargeIn: string;
  invoicesAutoChargeTomorrow: string;
  invoicesAutoChargeToday: string;
  invoicesDueIn: string;
  invoicesDueTomorrow: string;
  invoicesDueToday: string;
  invoicesPaymentFailed: string;
  invoicesPaymentReceived: string;
  invoicesUpdateCardCta: string;
  invoicesNumberRow: string;
  invoicesFilterNumberLabel: string;
  invoicesFilterNumberPlaceholder: string;
  invoicesFilterNumberClear: string;
  invoicesFilterEmpty: string;
  invoicesPaymentMethodRow: string;
  invoicesPaymentMethodLocked: string;
  invoicesPaymentMethodSaveFailed: string;
  invoicesPaymentMethodManualNote: string;
  invoicesPaymentMethodApply: string;
  invoicesPaymentMethodApplying: string;
  invoicesPaymentMethodSaved: string;
  invoicesPaymentMethodReset: string;
  invoicesReviewNoteManual: string;
  invoicesBackToList: string;
  invoicesReceiptHeading: string;
  invoicesLineItemsHeading: string;
  invoicesTimelineHeading: string;
  invoicesContractRow: string;
  invoicesCommissionRow: string;
  invoicesReceiptAmount: string;
  invoicesReceiptDate: string;
  invoicesReceiptCard: string;
  invoicesReviewNote: string;
  invoicesPrevPage: string;
  invoicesNextPage: string;
  invoicesPageOf: string;
  invoicesPage: string;
  invoicesPageSize: number;
  invoicesSeoDescription: string;
  invoicesTimelineCreated: string;
  invoicesTimelineReviewEnds: string;
  invoicesTimelineFinalized: string;
  invoicesTimelinePaid: string;
  invoicesTimelineFailed: string;
  dueBannersHeading: string;
  dueBannersHeadingSingular: string;
  dueBannersCollapseAll: string;
  dueBannersBarFailedLead: string;
  dueBannersBarFailedTail: string;
  dueBannersBarDueTodayLead: string;
  dueBannersBarDueTodayTail: string;
  dueBannersBarOverdueLead: string;
  dueBannersBarOverdueTail: string;
  dueBannersMeta: string;
  dueBannersMethodLine: string;
  dueBannersCardLabel: string;
  dueBannersNoCardOnFile: string;
  dueBannersUpdateCardCta: string;
  dueBannersViewInvoiceCta: string;
  dueBannersViewInvoiceLink: string;
  dueBannersDismissLabel: string;
  dueBannersDismissAllLabel: string;
  entraSignInLabel: string;
  entraSignInIntro: string;
  entraRedirecting: string;
  entraNotConfigured: string;
  entraCallbackVerifying: string;
  entraCallbackCancelled: string;
  entraCallbackStateMismatch: string;
  entraCallbackTransient: string;
  entraCallbackBackToLogin: string;
  orgPickerHeading: string;
  orgPickerIntro: string;
  orgPickerLoading: string;
  orgPickerError: string;
  orgPickerRetry: string;
  orgSwitcherLabel: string;
  orgRoleAdmin: string;
  orgRoleMember: string;
  teamNavLabel: string;
  teamHeading: string;
  teamIntro: string;
  teamLoading: string;
  teamLoadError: string;
  teamRetry: string;
  teamEmpty: string;
  teamColName: string;
  teamColEmail: string;
  teamColRole: string;
  teamApplyRole: string;
  teamColStatus: string;
  teamColActions: string;
  teamStatusActive: string;
  teamStatusInvited: string;
  teamStatusDeactivated: string;
  teamInviteHeading: string;
  teamInviteNameLabel: string;
  teamInviteNameInvalid: string;
  teamInviteEmailLabel: string;
  teamInviteRoleLabel: string;
  teamInviteSubmit: string;
  teamInviteSending: string;
  teamInviteSent: string;
  teamInviteError: string;
  teamInviteDuplicateMember: string;
  teamInviteDuplicatePending: string;
  teamDeactivateLabel: string;
  teamReactivateLabel: string;
  /** Team v2 (#535): "You" tag, invite Resend/Revoke, ConfirmDialog + toast copy. */
  teamYouTag: string;
  teamResendLabel: string;
  teamResent: string;
  teamRevokeLabel: string;
  teamRevokeTitle: string;
  teamRevokeBody: string;
  teamRevoked: string;
  teamDeactivateTitle: string;
  teamDeactivateBody: string;
  teamDeactivated: string;
  teamReactivated: string;
  teamViewAsHint: string;
  /** Builder-side view-as (2026-09-30, Karan): row action + error copy. */
  teamViewAsLabel: string;
  teamViewAsStarting: string;
  teamViewAsError: string;
  teamViewAsForbidden: string;
  /** auth/07: explainer shown under the disabled role select / Deactivate
      for the sole remaining active admin (exact story copy). */
  teamLastAdminRoleNote: string;
  teamLastAdminDeactivateNote: string;
  teamConfirmNo: string;
  teamActionError: string;
  shellHomeLabel: string;
  /** Builder shell v2 (#502, portal UI kit §4). */
  shellNavLabel: string;
  shellTabsLabel: string;
  shellNavMoney: string;
  shellMoneyNavLabel: string;
  shellAccountMenuLabel: string;
  shellSwitchOrgLabel: string;
  shellSignedInAs: string;
  shellFailedCardMessage: string;
  shellFailedCardCta: string;
  leadsSubtitle: string;
  leadsEmptyHeading: string;
  leadsEmptyGuidance: string;
  leadsFilterEmptyHeading: string;
  leadsFilterEmptyGuidance: string;
  leadsErrorHeading: string;
  leadsClearFilter: string;
  leadsStatusControlLabel: string;
  leadsStatusSaving: string;
  leadsStatusApply: string;
  leadsStatusLocked: string;
  /** Notes section header on each lead card. */
  commentsSectionTitle: string;
  /** Empty-state CTA that expands the thread. */
  commentsAddFirstNote: string;
  /** Empty-state hint above the CTA. */
  commentsEmptyHint: string;
  /** Composer footnote: who can see builder-posted notes. */
  commentsVisibleToOrg: string;
  /** Badge on notes written by the Feasly team (shared admin notes). */
  commentsTeamBadge: string;
  commentsEmpty: string;
  commentsPostFailed: string;
  commentsEditFailed: string;
  /** Honest copy when a write 401/403s on an expired session (QA P8). */
  commentsSessionExpired: string;
  commentsMaxLength: number;
  leadsWonHint: string;
  leadsWonReportCta: string;
  leadsRecordedCta: string;
  leadsViewInvoiceCta: string;
  leadsViewInvoiceWithNumber: string;
  teamColAdded: string;
  teamInviteButton: string;
  teamInviteModalSub: string;
  teamCountOne: string;
  teamCountMany: string;
  teamNotAdmin: string;
  billingCardPanelTitle: string;
  billingCardBrandLabel: string;
  billingCardNumberLabel: string;
  billingCardExpiryLabel: string;
  billingCardEmptyTitle: string;
  billingCardEmptyBody: string;
  contractWhatHappensTitle: string;
  contractFormHeading: string;
  contractLeadPlaceholder: string;
  contractEstimatedCommission: string;
  contractCommissionPanelSub: string;
  contractCommissionContractValue: string;
  contractCommissionRate: string;
  /** Leads home (#527): "Needs you" cards + pipeline table. */
  leadsHome: BuilderLeadsHomeCopy;
  /** Builder lead drawer (#528). */
  leadDrawer: BuilderLeadDrawerCopy;
  /** Invoice drawer + change-method modal (#533). */
  invoiceDrawer: BuilderInvoiceDrawerCopy;
  contractRetry: string;
  /** Money sub-nav: the overview page (#532). */
  shellNavMoneyOverview: string;
  /** Money page (#532) H1. */
  moneyHeading: string;
  /** Money page one-line description. */
  moneyDescription: string;
  /** Money page meta description. */
  moneySeoDescription: string;
  /** Accessible name for the KPI row. */
  moneyKpiLabel: string;
  /** Loading label for the KPI row. */
  moneyLoading: string;
  /** KPI row load error. */
  moneyLoadError: string;
  /** KPI: outstanding balance label. */
  moneyKpiOutstanding: string;
  /** KPI sub: {count} = unpaid invoice count (2+ or 0). */
  moneyKpiOutstandingSub: string;
  /** KPI sub for exactly one unpaid invoice. */
  moneyKpiOutstandingSubOne: string;
  /** KPI: next auto-charge label. */
  moneyKpiNextCharge: string;
  /** KPI value when no auto-charge is scheduled. */
  moneyKpiNextChargeNone: string;
  /** KPI sub when no auto-charge is scheduled. */
  moneyKpiNextChargeNoneSub: string;
  /** KPI sub: {date}, {last4}. */
  moneyKpiNextChargeSub: string;
  /** KPI sub when no card is saved: {date}. */
  moneyKpiNextChargeSubNoCard: string;
  /** KPI: failed payments label. */
  moneyKpiFailed: string;
  /** KPI sub when payments failed (tile links to the card page). */
  moneyKpiFailedSub: string;
  /** KPI sub when nothing failed. */
  moneyKpiFailedNoneSub: string;
  /** KPI: plan label. */
  moneyKpiPlan: string;
  /** KPI value under a commission plan: {rate} e.g. "1%". */
  moneyPlanCommission: string;
  /** KPI sub under a commission plan. */
  moneyPlanCommissionSub: string;
  /** KPI value under a flat plan. */
  moneyPlanFlat: string;
  /** KPI sub under a flat plan. */
  moneyPlanFlatSub: string;
  /** Recent invoices section heading. */
  moneyInvoicesHeading: string;
  /** Link to the full invoice list. */
  moneyInvoicesViewAll: string;
  /** Invoice table empty heading. */
  moneyInvoicesEmptyHeading: string;
  /** Invoice table empty body. */
  moneyInvoicesEmptyBody: string;
  /** Invoice table: review-window end column. */
  moneyColReviewEnds: string;
  /** Invoice table: lifecycle stepper column. */
  moneyColLifecycle: string;
  /** Accessible name of each invoice's lifecycle stepper. */
  moneyLifecycleLabel: string;
  /** Card panel heading. */
  moneyCardHeading: string;
  /** Card panel expiry line: {exp} = MM/YY. */
  moneyCardExpires: string;
  /** Card panel body when no card is saved. */
  moneyCardNone: string;
  /** Card panel link when a card is saved. */
  moneyCardManage: string;
  /** Card panel link when no card is saved. */
  moneyCardAdd: string;
  /** Card panel body under a flat plan. */
  moneyCardFlat: string;
  /** "How charges work" panel heading. */
  moneyHowHeading: string;
  /** Link to question an invoice (href: config billing.questionInvoiceHref). */
  moneyQuestionInvoice: string;
  /** Card modal (#534) title when a card is (or may be) on file. */
  cardModalTitleUpdate: string;
  /** Card modal title when no card is on file. */
  cardModalTitleAdd: string;
  /** "Replacing {card}." — {card} is "Visa •••• 4242". */
  cardModalCurrent: string;
  /** Shown while Stripe.js and the setup request load. */
  cardModalLoading: string;
  /** Stripe.js or the setup request failed (retry offered). */
  cardModalLoadError: string;
  /** Who handles the card number (no security claims). */
  cardModalReassurance: string;
  /** No publishable key, card on file: contact us to change it (no claim the card works — it may have just failed). */
  cardModalUnavailableWithCard: string;
  /** No publishable key, no card: billing is arranged by contacting Feasly. */
  cardModalUnavailableNoCard: string;
  /** Contact link label (href: config billing.questionInvoiceHref). */
  cardModalContact: string;
  /** Close button label / × aria-label. */
  cardModalClose: string;
}

/** Builder Leads home copy and display thresholds (#527, builder review §Leads home). */
export interface BuilderLeadsHomeCopy {
  heading: string;
  needsYouHeading: string;
  /** Group titles; `{days}` is the server's staleness threshold. */
  groups: { uncontacted: string; stale: string; wonWithoutContract: string };
  /** Age prefix per group, followed by a relative time ("2 hours ago"). */
  ageLabels: { uncontacted: string; stale: string; wonWithoutContract: string };
  allClearHeading: string;
  allClearMessage: string;
  needsYouError: string;
  callLabel: string;
  emailLabel: string;
  /** Accessible names; `{name}` is the lead's name. */
  callAria: string;
  emailAria: string;
  recordContractCta: string;
  /** Shown to members on won-without-contract cards (recording is admin-only). */
  recordContractMemberNote: string;
  pipelineHeading: string;
  statusFilterLabel: string;
  allStatusesLabel: string;
  searchLabel: string;
  searchPlaceholder: string;
  tableLabel: string;
  columns: { lead: string; status: string; details: string; activity: string };
  /** Details-cell timeline prefix ("Timeline 0–3 months"). */
  timelinePrefix: string;
  /** Text marker on stale rows (the highlight is never colour-only). */
  staleLabel: string;
  noResultsHeading: string;
  noResultsMessage: string;
  clearFiltersLabel: string;
  sortByLabel: string;
  defaultSortLabel: string;
  ascendingLabel: string;
  descendingLabel: string;
  previousLabel: string;
  nextLabel: string;
  pageLabel: string;
  pageOfLabel: string;
  actionsHeader: string;
  /** Rows per pipeline page. */
  pageSize: number;
  /** Lead-score heat pill (Hot ≥ hotMin, Warm ≥ warmMin, else Cool). */
  heat: {
    hot: string;
    warm: string;
    cool: string;
    hotMin: number;
    warmMin: number;
    /** Pill text: `{heat}` is Hot/Warm/Cool, `{score}` the 0–100 lead score. */
    chipLabel: string;
  };
  /** Wire project types → labels; unknown values are humanised. */
  projectTypes: Record<string, string>;
  closeLabel: string;
}

/** Builder invoice drawer + change-payment-method modal copy (#533). */
export interface BuilderInvoiceDrawerCopy {
  /** Drawer heading while the invoice loads. */
  loadingHeading: string;
  /** Header meta: `{number}` invoice number, `{lead}` lead name. */
  headerMeta: string;
  closeLabel: string;
  /** Accessible name of the lifecycle stepper. */
  lifecycleLabel: string;
  stepCompleteLabel: string;
  stepCurrentLabel: string;
  stepUpcomingLabel: string;
  breakdownHeading: string;
  /** Rate row label. */
  breakdownRate: string;
  /** Commission row label. */
  breakdownCommission: string;
  /** One-line summary: `{contract} × {rate} = {commission}` (all server figures). */
  breakdownFormula: string;
  paymentHeading: string;
  /** Opens the change-method modal. */
  changeMethod: string;
  /** Accessible name of the Change link: `{number}`. */
  changeMethodAria: string;
  timelineHeading: string;
  timelineEmpty: string;
  actionsHeading: string;
  questionInvoice: string;
  /** #661: invoice PDF/receipt download button. */
  downloadPdf: string;
  /** Button label while the PDF is being fetched. */
  downloadingPdf: string;
  /** Accessible name of the download button: `{number}`. */
  downloadPdfAria: string;
  /** Inline error when the PDF download fails. */
  downloadPdfError: string;
  /** Saved file name: `{number}` invoice number. */
  pdfFilename: string;
  /** Toast after a method change: `{method}`. */
  methodChangedToast: string;
  modalHeading: string;
  /** "Before" label in the modal. */
  modalBefore: string;
  /** "After" label in the modal. */
  modalAfter: string;
  /** Radio group legend. */
  modalChooseLabel: string;
  /** Marker next to the saved method in the radio list. */
  modalCurrentTag: string;
  /** After-panel text until a different method is picked. */
  modalNoChange: string;
  /** Effect line for the card on file. */
  modalEffectCard: string;
  modalSave: string;
  modalSaving: string;
  modalCancel: string;
}

/** Builder lead drawer copy (#528, artboard "Builder · Lead drawer"). */
export interface BuilderLeadDrawerCopy {
  /** Header meta: `{date}` is when the lead arrived. */
  arrivedMeta: string;
  contactHeading: string;
  statusHeading: string;
  detailsHeading: string;
  activityHeading: string;
  notesHeading: string;
  /** Accessible name of the status stepper. */
  progressLabel: string;
  stepCompleteLabel: string;
  stepCurrentLabel: string;
  stepUpcomingLabel: string;
  /** Group label for the "move to" buttons; `{name}` is the lead's name. */
  moveToLabel: string;
  /** Visible lead-in before the "move to" buttons. */
  moveToPrompt: string;
  /** Toast after a status change; `{status}` is the new status label. */
  statusChangedToast: string;
  /** Toast after Undo; `{status}` is the restored status label. */
  statusRevertedToast: string;
  undoLabel: string;
  /** Won → record contract panel. */
  wonPanelHeading: string;
  wonPanelBody: string;
  /** Lost → reason panel. */
  lostPanelHeading: string;
  lostPanelBody: string;
  lostReasonLabel: string;
  lostReasonPlaceholder: string;
  /** Reason options; the pick is saved to the notes thread. */
  lostReasons: readonly string[];
  lostReasonSave: string;
  /** Note body; `{reason}` is the picked reason. */
  lostReasonNote: string;
  lostReasonSaved: string;
  /** Activity timeline titles. */
  activityArrived: string;
  /** `{status}` is the current status label. */
  activityStatus: string;
  activityEmpty: string;
  showDetailsLabel: string;
  hideDetailsLabel: string;
  closeLabel: string;
  /** Pinned notes composer (drawer footer). */
  composerLabel: string;
  composerPlaceholder: string;
  postLabel: string;
  postingLabel: string;
  /** Unsaved note / lost reason: the discard question. */
  discardTitle: string;
  discardBody: string;
  discardVerb: string;
  discardCancel: string;
  /** Won panel: record the signed contract inline (#529). */
  record: BuilderRecordContractCopy;
}

/**
 * Lead drawer → record contract (#529). `{rate}`, `{value}`, `{commission}`,
 * `{card}`, `{date}`, `{method}`, `{name}`, `{days}` placeholders are filled
 * in the component; every figure comes from the API or the cost rate.
 */
export interface BuilderRecordContractCopy {
  valueLabel: string;
  valueHint: string;
  valueRequired: string;
  dateLabel: string;
  dateRequired: string;
  dateFuture: string;
  /** Live preview heading: `{rate}` e.g. "1%". */
  commissionLabel: string;
  /** Preview figure before a value is typed. */
  commissionEmpty: string;
  rateLoading: string;
  rateError: string;
  /** Flat plan: no commission on recorded contracts. */
  flatPlan: string;
  chargeDateLabel: string;
  cardLabel: string;
  /** Row label when the default method is manual. */
  paymentLabel: string;
  /** `{brand}` and `{last4}`. */
  cardValue: string;
  noCard: string;
  addCard: string;
  /** Manual default method: `{method}` (lower-case label). */
  manualMethod: string;
  reviewCta: string;
  /** Confirm title: `{name}` is the lead. */
  confirmTitle: string;
  /** `{commission}`, `{rate}`, `{value}`, `{card}`, `{date}` (+ the charge-timing sentence). */
  confirmBody: string;
  /** No card saved: `{commission}`, `{rate}`, `{value}`, `{date}`. */
  confirmBodyNoCard: string;
  /** Manual method: `{commission}`, `{rate}`, `{value}`, `{method}`. */
  confirmBodyManual: string;
  /** Flat plan: `{value}`. */
  confirmBodyFlat: string;
  confirmVerb: string;
  confirmVerbFlat: string;
  confirmCancel: string;
  submitting: string;
  successHeading: string;
  /** Success row labels. */
  successCommission: string;
  successChargeDate: string;
  successCountdown: string;
  /** Countdown: `{days}`. */
  countdownIn: string;
  countdownTomorrow: string;
  countdownToday: string;
  viewInvoice: string;
}

export interface AppConfig {
  /** Public site facts. */
  site: {
    /** Canonical origin, e.g. https://feasly.com. No trailing slash. */
    url: string;
    /** Brand name shown in the shell. */
    name: string;
    /** Site-root-relative path of the 1200×630 social share image. */
    socialImage: string;
  };
  /** Backend wiring. */
  api: {
    /** Base URL for /api/v1. Empty string = same origin. */
    baseUrl: string;
    /** True while the backend is unimplemented: use the mock harness (FE0-003). */
    useMockApi: boolean;
    /** HTTP timeout for API calls. */
    timeoutMs: number;
    /**
     * Gate-submit timeout. The lead-gate POST waits on the synchronous
     * email send (in-code retries: worst case ~20s), so it gets headroom
     * over the global timeout — without slowing every other API call.
     */
    gateTimeoutMs: number;
    /**
     * CSV-export timeout. Bulk export on a cold Azure Function plus CSV
     * generation for thousands of rows can exceed the standard timeout.
     */
    exportTimeoutMs: number;
    /**
     * Delay before revoking a blob object URL after a programmatic download
     * click. Revoking synchronously aborts the download in Safari/WebKit.
     */
    downloadRevokeDelayMs: number;
  };
  /**
   * Billing wiring (billing/02, BILL-02). Stripe publishable key for the
   * builder-portal card form (Stripe Elements). Empty string = card setup
   * is unavailable in the UI (the backend fails closed too). The secret key
   * never reaches the browser — it stays in the Function App's settings.
   */
  billing: {
    /** Stripe publishable key (`pk_test_…` in dev). Empty = unavailable. */
    stripePublishableKey: string;
    /**
     * Where the Money page's "Question an invoice" link goes (#532) — a
     * `mailto:` or contact URL, deploy-provided. Empty = the link is hidden
     * (builder disputes in-app are deferred; the contact inbox is an owner
     * decision).
     */
    questionInvoiceHref: string;
    /**
     * Days between an invoice being issued and the card charge (the
     * review window). Mirrors the backend's window so the record-contract
     * confirm can name the expected charge date before the invoice exists;
     * the minted invoice's own `reviewDueAt` is shown once it does.
     */
    chargeDelayDays: number;
  };
  /** Property-data wiring (FE1-002): autocomplete + property records. */
  propertyData: {
    /**
     * Which property backend serves autocomplete + property records:
     * - 'backend': our own /api/v1 property routes (served default, #752).
     * - 'mock': FE0-003 fixture harness (offline dev / CI).
     * - 'live': City of Calgary Socrata API from the browser (local dev only;
     *   misses the API's address normalisation and current district).
     * `baseUrl`/`datasetId`/`searchRowLimit`/`cacheTtlMs` apply to 'live' only.
     * Independent from `api.useMockApi`, which still switches the estimate /
     * lead / magic-link contracts.
     */
    source: 'live' | 'mock' | 'backend';
    /** Socrata host for the City dataset. No trailing slash. */
    baseUrl: string;
    /** Socrata dataset id for Current Year Property Assessments (Parcel). */
    datasetId: string;
    /** Rows fetched per autocomplete query before client-side dedupe. */
    searchRowLimit: number;
    /** TTL for cached Socrata responses (courtesy rate limiting). */
    cacheTtlMs: number;
  };
  /** Feature flags. */
  features: {
    /** Show the "view sample report" entry point. */
    sampleReport: boolean;
    /**
     * #520 (D-P4): badge the Renovation card "Coming soon" on the scope step
     * and capture an email there instead of sending users through the reno
     * scope form to a dead end.
     */
    renovationWaitlist: boolean;
    /** #520 (D-P4): notify-me capture (Toronto/Vancouver) on the out-of-coverage state. */
    cityWaitlist: boolean;
  };
  /**
   * Legal review state (legal/01 AC3 — the LEGAL_REVIEW_PENDING mechanism).
   * True while the privacy/terms copy is draft-pending-lawyer: the legal
   * pages render the "draft — pending legal review" banner, and the HRD-05
   * legal gate blocks production deploys while true.
   */
  legal: {
    /** Draft legal copy is still awaiting lawyer review. */
    reviewPending: boolean;
  };
  /** Wizard tunables (FE-2). */
  wizard: {
    sqftDefault: number;
    sqftMin: number;
    sqftMax: number;
    /** Slider step in sq ft. */
    sqftStep: number;
    /** Reno scope step tunables (RENO-03). */
    renoSqftDefault: number;
    renoSqftMin: number;
    renoSqftMax: number;
    /** Reno slider step in sq ft. */
    renoSqftStep: number;
    /** Additions bill at most this many sq ft (RENO-01). */
    renoAdditionCap: number;
  };
  /** UX timings. */
  timings: {
    /** Address-autocomplete debounce. */
    debounceMs: number;
    /** Report sqft-stepper live-revise debounce (D-02: 400 ms trailing). */
    reviseDebounceMs: number;
    /** Portal FilterBar search debounce (portal-ui-kit §3: 250 ms). */
    filterDebounceMs: number;
    /** Cooldown between magic-link resends. */
    resendCooldownSec: number;
    /** Mock API latency window (FE0-003). Real API ignores these. */
    mockLatencyMinMs: number;
    mockLatencyMaxMs: number;
    /** Analyzing pipeline stage timeout (an API stage slower than this fails honestly). */
    analyzingTimeoutMs: number;
    /** Portal UI kit Toast auto-dismiss (portal-ui-kit §3: 5s). */
    toastDurationMs: number;
  };
  /** Collection limits. */
  limits: {
    /** Max communities rendered on community listing pages. */
    communityPageLimit: number;
    /** Max address suggestions shown in autocomplete. */
    autocompleteSuggestionLimit: number;
    /** Max community suggestions shown in the site search (#783). */
    communitySuggestionLimit: number;
    /**
     * Estimate input bounds, mirrored from the cost-data file
     * (packages/cost-engine/cost-data inputBounds). The property record
     * carries no eligibility verdict (on every propertyData.source), so the
     * client needs the assessed-value bounds for the early coverage guard.
     * `minLotSizeSqft`/`maxLotSizeSqft` are RESERVED for future bigger-lot
     * calibration (Karan, 2026-09-28) — NOT enforced anywhere; the
     * estimator never blocks on lot size. estimate-input-bounds-drift.spec.ts
     * fails CI if the values diverge from the cost data.
     */
    minLotSizeSqft: number;
    maxLotSizeSqft: number;
    minAssessedLandValue: number;
    maxAssessedLandValue: number;
    /**
     * Display rounding step (whole dollars) for consumer estimate figures
     * (#504, #608): no estimate renders more precise than this. Mirrors the
     * top-level `roundTo` of the pinned cost-data file;
     * estimate-input-bounds-drift.spec.ts fails CI if they diverge.
     */
    estimateRoundingStep: number;
  };
  /**
   * Estimator eligibility by city (#685). The early coverage guard
   * (core/utils/coverage.ts) reads these lists; no district code literal
   * lives in code. When the zoning catalogue story lands it becomes the
   * single source and this key goes away.
   */
  coverage: {
    /**
     * Land-use districts where a single-detached dwelling is a listed use,
     * keyed by city. Matched case-insensitively against each token of the
     * City `land_use_designation` (compound values like 'R-1N,R-G' pass when
     * ANY token is listed). Blank/unknown zoning always fails open. The
     * zoning guide table is held to this list by
     * coverage-zoning-copy-drift.spec.ts.
     */
    singleFamilyDistricts: {
      calgary: readonly string[];
    };
  };
  /**
   * Estimator deep link (#692): `/?address=<text>&src=<source>` opens the
   * landing page with the address prefilled and looked up. Values outside
   * these bounds are ignored (plain landing page).
   */
  deepLink: {
    /** Shortest address accepted (matches the autocomplete's 3-char search minimum). */
    addressMinLength: number;
    /** Longest raw `address` parameter accepted; anything longer is ignored. */
    addressMaxLength: number;
    /** Allowlisted `src` values kept for attribution; any other value is dropped. */
    sources: readonly string[];
    /**
     * #783: `src` the nav site search sends when it opens the estimator with
     * a picked address. Must be one of `sources`.
     */
    siteSearchSource: string;
  };
  /** Analytics consent. */
  analytics: {
    enabled: boolean;
    /** Exact opt-in wording shown to the user. */
    optInWording: string;
  };
  /** User-facing copy, namespaced by area. Extended by FE1-001. */
  admin: {
    /** Default per-minute rate limit prefilled in the issue form. */
    defaultRateLimit: number;
    /** Highest per-minute rate limit the API accepts (mirrors the zod max). */
    rateLimitMax: number;
    /** Longest API key name the API accepts (mirrors the zod max). */
    apiKeyNameMax: number;
    /**
     * Environment chip in the admin top bar (#503), e.g. "Dev". Empty hides
     * the chip. Per-deploy value: set in the served app-config.json.
     */
    environmentLabel: string;
    /** Admin Leads saved views (#539). */
    leads: {
      /** "Quoting > N days" saved view: quoting leads created more than N days ago. */
      quotingStaleDays: number;
    };
    /** Admin Quarantine (#540). */
    quarantine: {
      /** Parallel approve/discard calls in a bulk run (no bulk endpoint exists). */
      bulkConcurrency: number;
    };
    /** ⌘K palette query cap — matches GET /api/v1/admin/search's max (#538). */
    searchMaxQueryLength: number;
    /**
     * Microsoft Entra External ID (auth/02 pivot, AUTH-02). All three are
     * deploy-time values — the compiled defaults are placeholders that
     * MUST be replaced in app-config.json before the Entra flow can start.
     */
    entra: {
      /**
       * Tenant subdomain: sign-in happens at
       * `https://{tenantSubdomain}.ciamlogin.com/{tenantId}/…`.
       * Placeholder key name: ENTRA_TENANT_SUBDOMAIN.
       */
      tenantSubdomain: string;
      /**
       * Directory (tenant) ID from the Entra External ID tenant.
       * Placeholder key name: ENTRA_TENANT_ID.
       */
      tenantId: string;
      /**
       * Application (client) ID of the Feasly admin app registration.
       * Placeholder key name: ENTRA_CLIENT_ID.
       */
      clientId: string;
      /**
       * Sign-up/sign-in user flow name (e.g. `feasly-signup-signin`).
       * Passed as the `p` query parameter on the authorize request so
       * Entra External ID runs the right flow. Without it the authorize
       * request is rejected.
       * Placeholder key name: ENTRA_USER_FLOW.
       */
      userFlow: string;
      /**
       * Microsoft-hosted authorize endpoint template. `{tenantSubdomain}`
       * and `{tenantId}` are substituted at sign-in time. Lives in config
       * (not code) so sovereign clouds (e.g. `ciamlogin.us`) or future
       * endpoint versions need no code change.
       */
      authorizeUrlTemplate: string;
    };
  };
  copy: {
    /** Short brand tagline used in the shell footer / meta fallbacks. */
    tagline: string;
    /**
     * Verbatim footer on every AI narrative (moved out of @feasly/contracts in
     * the FE0-001 audit — contracts are shapes-only; copy lives in config).
     * Exact wording is copy-linted: do not paraphrase.
     */
    narrativeDisclaimer: string;
    /**
     * Landing page (S0) copy. Every string rendered on `/` lives here so the
     * no-hardcode tripwire stays green and copy is deploy-tunable.
     * `trustItems` must never carry ±, %, or accuracy claims (copy-linted).
     */
    landing: {
      eyebrow: string;
      heroTitle: string;
      heroSub: string;
      /** Short description for SEO JSON-LD (WebSite schema). */
      seoDescription: string;
      /** Trust-strip stat blocks (redesigned 2026-09-28): big value + small label. */
      trustItems: TrustStat[];
      /**
       * Shown instead of `trustItems` while the mock property harness
       * serves the data (`propertyData.source === 'mock'`): sample values
       * must never claim live City data (trust rule).
       */
      trustItemsMock: TrustStat[];
      /** Small caps label above the trust-strip stats ("Why Feasly"). */
      trustEyebrow: string;
      howItWorksTitle: string;
      howItWorksSub: string;
      steps: { n: string; title: string; body: string }[];
      /** Label for the optional sample-report entry (needs `features.sampleReport`). */
      sampleReportLabel: string;
      /**
       * Substantive SEO sections on the landing page (SEO pass 4): keyword-
       * bearing, buyer-grade content for the target intents (cost to build,
       * renovations, builders). Links are plain copy — anchors live in the
       * template.
       */
      seoSections: {
        costFactorsTitle: string;
        costFactorsBody: string;
        renoTitle: string;
        renoBody: string;
        buildersTitle: string;
        buildersBody: string;
        buildersCta: string;
      };
    };
    /** Address-autocomplete strings, shared by landing (S0) and wizard (S1). */
    search: {
      label: string;
      placeholder: string;
      submitLabel: string;
      /** Shown when submitting with fewer than 3 characters typed. */
      emptyHint: string;
      /**
       * Shown when submitting with 3+ characters typed but no suggestion
       * selected: the CTA must never proceed with an unresolved address.
       */
      selectHint: string;
      /** Shown when a 3+ char query returns zero suggestions. */
      noResults: string;
      /** #701: no-results hint when the query is a postal code. */
      noResultsPostalCode: string;
      /** #701: no-results hint when the query has no house number. */
      noResultsNoHouseNumber: string;
      /** #701: no-results hint when the query names a unit/suite. */
      noResultsUnit: string;
      /**
       * Calgary-only gate (reno/05): exact story-pinned copy. Shown when the
       * property lookup reports OUT_OF_COVERAGE. Do not paraphrase.
       */
      outOfCoverageHeading: string;
      outOfCoverageBody: string;
      /**
       * Out-of-coverage action label (B11, #514). Clears and focuses the
       * input — never "Retry", since coverage is deterministic.
       */
      outOfCoverageAction: string;
      /** Shown when the autocomplete request fails. */
      error: string;
      retryLabel: string;
      searchingLabel: string;
      /** #783 site search: accessible label for the address-or-community box. */
      siteSearchLabel: string;
      /** #783 site search: placeholder for the address-or-community box. */
      siteSearchPlaceholder: string;
      /** #783 site search: listbox group headings. */
      communitiesGroupLabel: string;
      addressesGroupLabel: string;
      /** #783 site search: secondary line on a community option. */
      communityOptionHint: string;
    };
    /**
     * White-label embed shell strings (EMB-01). The unavailableBody copy is
     * story-pinned — the exact fallback text, never a blank iframe.
     */
    embed: {
      /** Screen-reader label for the widget region. */
      widgetLabel: string;
      /** Shown while the builder config loads. */
      loadingLabel: string;
      /** Fallback card heading when the tenant config can't be resolved. */
      unavailableHeading: string;
      /** Exact fallback body (story-pinned). */
      unavailableBody: string;
      /** Intentional heading for a keyless /embed visit (not an outage). */
      missingKeyHeading: string;
      /** Intentional body for a keyless /embed visit (not an outage). */
      missingKeyBody: string;
      /** CTA label on the widget. */
      ctaLabel: string;
      /** Contact-line prefix; the builder's phone/email follow. */
      contactPrefix: string;
      /** "Powered by" badge text — non-removable in v1. */
      poweredBy: string;
      /**
       * Relay session strings (embed/06). Shown when the one-time relay code
       * has expired or was already used — the user gets a fresh link, never
       * a dead end.
       */
      sessionExpiredHeading: string;
      sessionExpiredBody: string;
      resendLinkLabel: string;
      /** Busy label on the fresh-link button while the re-issue is in flight. */
      resendLinkBusyLabel: string;
      /** Shown when the 60s per-code resend cooldown fires (embed/06 AC3). */
      resendCooldownBody: string;
    };
    /**
     * Wizard scope-step copy (S2 — FE-2). Step labels are structural;
     * everything user-facing stays tunable here. Tier `id`s must match the
     * FinishTier contract union; blurbs carry no prices, ever.
     */
    wizard: {
      stepAddress: string;
      stepScope: string;
      /** #507: third step of Address → Your home → Estimate (preview + gate). */
      stepEstimate: string;
      scopeHeading: string;
      scopeSqftLabel: string;
      scopeSqftHint: string;
      scopeSqftUnit: string;
      scopeTierLabel: string;
      scopeTierHint: string;
      scopeTiers: { id: FinishTier; name: string; blurb: string }[];
      /**
       * Garage selector (consumer/05): `id`s must match the GarageOption
       * contract union; blurbs carry no prices, ever.
       */
      scopeGarageLabel: string;
      scopeGarageHint: string;
      scopeGarages: { id: GarageOption; name: string; blurb: string }[];
      /**
       * Basement selector (consumer/05): `id`s must match the BasementOption
       * contract union; blurbs carry no prices, ever.
       */
      scopeBasementLabel: string;
      scopeBasementHint: string;
      scopeBasements: { id: BasementOption; name: string; blurb: string }[];
      scopeBackLabel: string;
      scopeCta: string;
      scopeEmpty: string;
      scopeEmptyCta: string;
      /**
       * Project-type selector (RENO-02): both cards enabled, no "coming soon".
       * `id`s must match the ProjectType union in the wizard actions.
       */
      scopeProjectTypeLabel: string;
      scopeProjectTypes: { id: 'new-build' | 'renovation'; name: string; blurb: string }[];
      /** Shown under the cards when Renovation is selected (no prices, ever). */
      renoSelectedNote: string;
      /** #520: badge on the Renovation card while `features.renovationWaitlist` is on. */
      renoComingSoonBadge: string;
      /** #520: secondary action under the reno waitlist — back to the working flow. */
      renoNewBuildCta: string;
      /** Placeholder for the reno scope-inputs step until RENO-03 builds it. */
      renoScopePendingTitle: string;
      renoScopePendingBody: string;
      renoScopeBackLabel: string;
      /** RENO-03 reno scope-inputs step copy. */
      renoScopeHeading: string;
      renoTypeLabel: string;
      renoTypes: { id: 'extensive' | 'addition' | 'basement' | 'combined'; name: string; blurb: string }[];
      renoSqftLabel: string;
      renoSqftHint: string;
      renoSqftUnit: string;
      renoAdditionCapNote: string;
      renoSqftClampNote: string;
      renoTierLabel: string;
      renoTierHint: string;
      renoUnderpinningLabel: string;
      renoUnderpinningBlurb: string;
      renoPermitNote: string;
      renoScopeCta: string;
      renoScopeEmpty: string;
      renoScopeEmptyCta: string;
    };
    /**
     * Neighbourhood comparison flow copy (NBH-04): the landing entry card
     * and the /estimate/compare picker. Exact user-facing strings required
     * by the story live here — never hardcoded in templates.
     */
    comparison: {
      /** Landing entry card title: exact copy "Compare neighbourhoods". */
      landingTitle: string;
      /** Landing entry card body: exact copy "Side-by-side build costs for 2–3 Calgary communities." */
      landingBody: string;
      /** Picker page heading. */
      pickerHeading: string;
      /** Picker page subheading. */
      pickerSubheading: string;
      /** Community search input label. */
      searchLabel: string;
      /** Community search input placeholder. */
      searchPlaceholder: string;
      /** Shown when the search matches no communities. */
      searchNoResults: string;
      /** Selected-communities section label. */
      selectedLabel: string;
      /** Clears all selected communities. */
      clearAllLabel: string;
      /** Sqft section copy for the shared slider. */
      sqftLabel: string;
      sqftHint: string;
      sqftUnit: string;
      /** Tier section copy for the shared selector. */
      tierLabel: string;
      tierHint: string;
      /** Exact warning when a fourth community is picked: "You can compare up to 3 communities." */
      maxCommunitiesNote: string;
      /** CTA — exact copy "Compare →". */
      cta: string;
      /** Shown under the disabled CTA until 2 communities are selected. */
      ctaHint: string;
      /**
       * Interim confirmation (NBH-04 only): shown after the CTA until NBH-03
       * lands the real comparison result pipeline. Honest placeholder copy —
       * never pretends a result exists.
       */
      interimTitle: string;
      interimBody: string;
      interimBackLabel: string;
      /**
       * Comparison results (NBH-03): side-by-side cards + bar chart.
       * Exact user-facing strings required by the story live here — never
       * hardcoded in templates.
       */
      /** Results page heading. */
      resultsHeading: string;
      /** Summary line under the heading (sqft + tier filled by the component). */
      resultsSubheading: string;
      /** Exact label above each community's City-assessed figure. */
      assessedLabel: string;
      /** Visible pre-gate: the fixed land figure label (never a range). */
      landLabel: string;
      /** Blurred pre-gate: the build cost label. */
      buildLabel: string;
      /** Blurred pre-gate: the total figure label. */
      totalLabel: string;
      /**
       * Transparent total derivation shown under each total:
       * '{assessed}' + '{buildRange}'.
       */
      totalMathTemplate: string;
      /** Exact badge copy on the cheapest-land community: "Lowest land cost". */
      lowestLandBadge: string;
      /** Screen-reader / visible alternative where blurred figures sit. */
      lockedNote: string;
      /** Single unlock CTA — exact copy "Unlock Full Numbers →". */
      unlockCta: string;
      /** Returns to the picker with selections intact. */
      editLabel: string;
      /** Bar chart title. */
      chartTitle: string;
      /** Chart axis note: ranges per community, never $/sqft or margins. */
      chartAxisNote: string;
      /** Analyzing beat stage labels (each tied to a real awaited operation). */
      analyzingValidate: string;
      analyzingFetch: string;
      analyzingCalculate: string;
      /** Tier what-if (post-gate): re-runs every row-set inline. */
      whatIfLabel: string;
      whatIfHint: string;
    };
    /**
     * Estimate preview step (S5) copy — the single lead-gate point.
     * Figure labels, the locked note, and the one "Unlock" CTA live with the
     * report copy (single source); the loading/error/retry strings are reused
     * from there too. Nothing here may carry ±, %, or accuracy claims.
     */
    preview: {
      heading: string;
      readyNote: string;
      /** Back to the scope step (new build and reno alike — #507 removed Details). */
      backLabel: string;
      /** #507 recap chip: "Edit" link text, its accessible name, and the sq ft unit. */
      recapEditLabel: string;
      recapEditAriaLabel: string;
      recapSqftUnit: string;
      /**
       * Validation-failure explainer (consumer/06): shown when the preview
       * API rejects the request (e.g. assessed value out of range). Retry
       * cannot succeed, so no retry button — just a plain-English
       * explanation and a way back. Lot size NEVER blocks (Karan,
       * 2026-09-28): the engine prices any lot.
       */
      validationHeading: string;
      validationGenericBody: string;
      /**
       * Non-residential coverage explainer: shown when the City classifies
       * the parcel commercial/industrial. Takes precedence over the generic
       * body in the early coverage guard (landing + embed).
       */
      validationNonResidentialBody: string;
      /**
       * Unsupported-property-type coverage explainer: shown when the City
       * land-use designation is outside the single-family set the estimator
       * quotes (R-C2, R-CG, M-*, …). Takes precedence over the generic body,
       * after the non-residential check, in the early coverage guard
       * (landing + embed).
       */
      validationUnsupportedPropertyTypeBody: string;
      /**
       * Zoning-guide cross-link (SEO guides): shown under the
       * unsupported-property-type message, linking to the
       * "why Feasly only quotes single-family homes" FAQ anchor.
       */
      validationZoningGuideLink: string;
      validationBackLabel: string;
    };
    /**
     * One freshness story (#513): the landing trust strip and the property
     * card both render "{rollTemplate} {detailTemplate}" →
     * "2026 assessment roll (City of Calgary) · checked Nov 2026". Unknown
     * parts fall back to `rollUnknownYear` / `detailUnchecked`.
     */
    dataFreshness: DataFreshnessCopy;
    /** Property card (shared) copy. */
    propertyCard: {
      /**
       * Freshness line while the mock property harness serves the data
       * (`propertyData.source === 'mock'`): sample values must never
       * masquerade as City records (trust rule).
       */
      freshnessMock: string;
    };
    /**
     * Estimate report page copy. The hero is range-first (#504): the total
     * range is the headline and the engine's deterministic base sits under
     * it as "Most likely ≈" — never Low/Base/High labels on the report. Nothing
     * here may carry ±, %, or accuracy claims (copy-linted).
     */
    report: {
      heading: string;
      subPreGate: string;
      subPostGate: string;
      totalLabel: string;
      /**
       * "Most likely ≈" — prefixes the secondary base figure under a
       * range-first headline (#504: the range is the hero, never the point).
       */
      mostLikelyLabel: string;
      /** PDF variant of `mostLikelyLabel` — the embedded PDF fonts have no "≈" glyph. */
      mostLikelyPdfLabel: string;
      buildLabel: string;
      /** Clarifier under the highlighted build-cost figure. */
      buildCostNote: string;
      /** Source label under the build-cost figure: data-driven trust. */
      buildSourceNote: string;
      /** Label for the City-assessed figure (land + existing home, #505). */
      landLabel: string;
      /** One-line note under the land figure: it includes the current house. */
      landHouseNote: string;
      /** Fixed-figure explainer: City assessment, never a range. */
      landFixedNote: string;
      /** Unit-address honesty note: lot figures are for the whole building. */
      unitAddressNote: string;
      lowLabel: string;
      baseLabel: string;
      highLabel: string;
      uncalibratedNote: string;
      /** "How we calculate" expandable on the report — data-driven trust. */
      howWeCalculateTitle: string;
      howWeCalculateItems: string[];
      lockedNote: string;
      unlockCta: string;
      /** Post-gate confirmation line: the emailed link is return-access for other devices. */
      leadLinkNote: string;
      /** Duplicate-submit variant of the lead-link note: no new email was sent. */
      leadLinkNoteDuplicate: string;
      /**
       * Send-failure variant of the lead-link note: the lead was saved and
       * the report unlocked (reportToken present) but the magic-link email
       * failed to send — nudges the user to check their inbox or try again.
       */
      leadLinkNoteFailed: string;
      /**
       * Invalid-recipient variant: the address itself was rejected
       * (emailError === 'invalid-recipient') — asks the user to check for
       * typos instead of "check your inbox", which would never arrive.
       */
      leadLinkNoteInvalidRecipient: string;
      breakdownTitle: string;
      breakdownLocked: string;
      /** Display-only finish tier on the report ("Selected finish level — Standard"). */
      finishLevelLabel: string;
      /** Short honest descriptor of the selected finish tier (no prices). */
      tierDescriptors: { standard: string; premium: string; luxury: string };
      /** Upgrades-are-explicit-choices note under the tier descriptor. */
      tierChoicesNote: string;
      /** "What your estimate covers" — honest included/excluded framing. */
      coverageTitle: string;
      /** One-line "full build" framing above the exclusions list. */
      includedLine: string;
      /** Honest note: inflation, material choices, project conditions can move costs. */
      costMovementNote: string;
      /** "What's not in this estimate" heading. */
      exclusionsTitle: string;
      /** Honest exclusion list — landscaping only (Karan 2026-09-28: the estimate covers the full build except landscaping). */
      exclusions: string[];
      tierTitle: string;
      tierLockedNote: string;
      /** What-if toggle hint (report page, post-gate): instant-plain, mirrors adjustHint. */
      tierToggleHint: string;
      adjustTitle: string;
      decreaseLabel: string;
      increaseLabel: string;
      adjustHint: string;
      adjustUnit: string;
      adjustCta: string;
      adjustLockedNote: string;
      /** RENO: the size stepper becomes an affected-area stepper on reno reports. */
      adjustTitleReno: string;
      adjustHintReno: string;
      adjustLockedNoteReno: string;
      /** RENO: label for the renovation-type + affected-area scope line. */
      renoScopeLabel: string;
      /** Shown while a debounced sqft revision is in flight. */
      updatingLabel: string;
      /** "Updated {date}" — shown when an old magic link resolved to a newer snapshot (consumer/02). */
      updatedLabel: string;
      /** Print-only header date line (#509): "Prepared {date}". */
      printPreparedLabel: string;
      /** "$X per sq ft" context line under the build cost. */
      perSqftUnit: string;
      narrativeTitle: string;
      narrativeComingSoon: string;
      aiSummaryLocked: string;
      /** Shown post-gate when the AI narrative could not be produced — never mock text. */
      aiSummaryUnavailable: string;
      /** Title for the static Calgary guide shown when every narrative model failed (BE-9). */
      staticGuideTitle: string;
      /** Honest sub-note under the static guide title — never implies AI prose. */
      staticGuideNote: string;
      stepsTitle: string;
      /** Numbered next steps — printed in the PDF (the web report has no checklist, #508). */
      steps: { id: string; title: string; body: string }[];
      /** #508: accessible name of the Build | Land "what makes up the total" row. */
      makeupLabel: string;
      /** #508: title of the single Adjust panel (size stepper + tier what-if). */
      adjustPanelTitle: string;
      /** #508: title of the Share / PDF / New estimate action row. */
      actionsTitle: string;
      /** "Planning ahead" card: financing + timeline honesty for prospects. */
      planningTitle: string;
      financingTitle: string;
      financingLines: string[];
      timelineTitle: string;
      timelineLine: string;
      shareTitle: string;
      shareHint: string;
      shareEmailLabel: string;
      shareCta: string;
      shareInvalid: string;
      /** Partner-share button label while the backend sends the email. */
      shareSending: string;
      /** Partner-share success copy; `{email}` is the recipient's address. */
      shareSent: string;
      /** Partner-share send failure (retry stays available on the button). */
      shareError: string;
      /**
       * Partner-share when the recipient address is the owner's own —
       * caught client-side before the backend's CAP-008 self-share 400.
       */
      shareSelfError: string;
      /** Partner share when the memory-only report token is gone. */
      shareTokenError: string;
      /** Partner-share button label after a send failure. */
      shareRetry: string;
      /**
       * Read-only banner on the report page when the session redeemed a
       * partner-share link (the stepper, share form, and callback form are
       * hidden in partner view).
       */
      partnerViewNote: string;
      /** #508: title of the single "Talk to a builder" block (callback + explainer). */
      callbackTitle: string;
      callbackHint: string;
      callbackNameLabel: string;
      callbackPhoneLabel: string;
      callbackWindowLabel: string;
      callbackWindows: { id: CallbackWindow; label: string }[];
      callbackCta: string;
      callbackSuccess: string;
      callbackError: string;
      callbackInvalid: string;
      pdfCta: string;
      pdfGenerating: string;
      pdfError: string;
      /** Inside the PDF: honest line when the AI narrative is empty. */
      pdfNarrativeFallback: string;
      /** Inside the PDF: '{sqft}' and '{tier}' template for the size/finishes row. */
      pdfInputsLine: string;
      loadingLabel: string;
      loadError: string;
      retryLabel: string;
      versionLabel: string;
      /** RENO-04: reno-specific report copy (exact copy required by AC). */
      renoPermitNote: string;
      renoDeterministicNote: string;
      estimateAnotherLabel: string;
    },
    /**
     * Lead-gate step (FE-004) copy. The single gate in the flow: name/email
     * required, phone/timeline optional, contact-consent checkbox required.
     */
    gate: {
      heading: string;
      sub: string;
      /** Quiet trust line under the gate subheading — data-driven, not a calculator. */
      trustLine: string;
      nameLabel: string;
      namePlaceholder: string;
      nameRequired: string;
      emailLabel: string;
      emailPlaceholder: string;
      emailRequired: string;
      emailInvalid: string;
      phoneLabel: string;
      phonePlaceholder: string;
      /** Short "(optional)" marker rendered beside optional labels. */
      optionalMarker: string;
      phoneInvalid: string;
      /** JS RegExp source for the optional phone field (no hardcode). */
      phonePattern: string;
      timelineLabel: string;
      /** RENO-06: reno variant of the timeline question, selected by projectType. */
      timelineLabelReno: string;
      timelinePlaceholder: string;
      /** Shown when the (required) timeline question is left unanswered. */
      timelineRequired: string;
      /** `id`s must match the TimelineOption contract union. */
      timelineOptions: { id: TimelineOption; label: string }[];
      /**
       * Required contact-consent checkbox (Karan 2026-09-27): Feasly and
       * builders associated with us may contact the lead about their
       * estimate; the lead can opt out anytime. Wording is a DRAFT pending
       * legal review — do not present as lawyer-approved.
       */
      consentLabel: string;
      /** Inline error when the required consent checkbox is unchecked. */
      consentRequired: string;
      privacyNote: string;
      privacyLinkLabel: string;
      submitLabel: string;
      submittingLabel: string;
      submitError: string;
      retryLabel: string;
      /** Back-bar label for wizard leads — returns to the preview they just saw. */
      backLabel: string;
      /** Back-bar label for comparison leads (NBH-03) — returns to the comparison. */
      backLabelComparison: string;
    };
    /**
     * Analyzing screen (FE-004) copy. Stages describe real pipeline work —
     * never fake progress.
     */
    analyzing: {
      heading: string;
      sub: string;
      stageValidate: string;
      stageFetch: string;
      stageEstimate: string;
      /** Screen-reader status words for each stage. */
      statusPending: string;
      statusActive: string;
      statusDone: string;
      statusError: string;
      errorHeading: string;
      errorBody: string;
      retryLabel: string;
      /** Back link out of the analyzing screen (the pipeline must never trap the user). */
      backLabel: string;
    };
    /** #520 waitlist capture (renovation + other cities). Shared form copy. */
    waitlist: {
      emailLabel: string;
      emailPlaceholder: string;
      submitLabel: string;
      sendingLabel: string;
      invalidEmail: string;
      error: string;
      /** What the email is used for (shown under the field). */
      privacyNote: string;
      /**
       * CASL consent checkbox label (owner decision 2026-11-15). REQUIRED to
       * submit. Byte-checked against docs/legal/approved-copy.md "CASL
       * waitlist consent wording" by tools/check-casl-copy.mjs.
       */
      consentLabel: string;
      /** The words inside `consentLabel` that link to the privacy page. */
      privacyLinkLabel: string;
      /** Inline error when submitting without the consent box ticked. */
      consentRequired: string;
      /** Shown after a successful signup, per topic. */
      successByTopic: Record<WaitlistTopic, string>;
      renovation: { heading: string; body: string };
      city: {
        heading: string;
        body: string;
        /** Legend for the city choice. */
        topicLabel: string;
        /** City choices, in display order. `match` preselects from the typed address. */
        cities: { id: WaitlistTopic; name: string; match: string }[];
      };
    };
    /** Renovation coming-soon page (reno out of launch scope, Karan 2026-09-27). */
    renoComingSoon: {
      heading: string;
      body: string;
      newBuildCta: string;
      /** Back link to the reno scope step. */
      backLabel: string;
    };
    /** Per-page SEO titles + descriptions (long literals live here, not in components). */
    seo: {
      landingTitle: string;
      landing: string;
      scopeTitle: string;
      scope: string;
      renoScopeTitle: string;
      renoScope: string;
      previewTitle: string;
      preview: string;
      reportTitle: string;
      report: string;
      sampleReportTitle: string;
      sampleReport: string;
      gateTitle: string;
      gate: string;
      analyzingTitle: string;
      analyzing: string;
      renoComingSoonTitle: string;
      renoComingSoon: string;
      compareTitle: string;
      compare: string;
      privacyTitle: string;
      privacy: string;
      termsTitle: string;
      terms: string;
      howItWorksTitle: string;
      howItWorks: string;
      faqTitle: string;
      faq: string;
      pillarGuideTitle: string;
      pillarGuide: string;
      zoningGuideTitle: string;
      zoningGuide: string;
      developersTitle: string;
      developers: string;
      communitiesTitle: string;
      communities: string;
      notFoundTitle: string;
      notFound: string;
      unsubscribeTitle: string;
      unsubscribe: string;
      magicLinkTitle: string;
      magicLink: string;
      myReportTitle: string;
      myReport: string;
      errorTitle: string;
      error: string;
      /** Admin console (admin/07): per-section titles for client-side nav. All noindexed. */
      adminHomeTitle: string;
      adminHome: string;
      adminLeadsTitle: string;
      adminLeads: string;
      adminBuildersTitle: string;
      adminBuilders: string;
      adminUsersTitle: string;
      adminUsers: string;
      adminDisputesTitle: string;
      adminDisputes: string;
      adminCalibrationTitle: string;
      adminCalibration: string;
      adminBillingTitle: string;
      adminBilling: string;
      adminInvoicesTitle: string;
      adminInvoices: string;
      adminInvoiceDetailTitle: string;
      adminInvoiceDetail: string;
      adminSheetsTitle: string;
      adminSheets: string;
      adminEstimatesTitle: string;
      adminEstimates: string;
      adminApiKeysTitle: string;
      adminApiKeys: string;
      adminFunnelsTitle: string;
      adminFunnels: string;
      adminWebhooksTitle: string;
      adminWebhooks: string;
      adminQuarantineTitle: string;
      adminQuarantine: string;
      adminLoginTitle: string;
      adminLogin: string;
      adminCallbackTitle: string;
      adminCallback: string;
    };
    /**
     * Marketing pages (SEO-010). All user-facing copy for `/how-it-works`
     * and `/faq` lives here so the no-hardcode tripwire stays green and
     * copy is deploy-tunable. No accuracy guarantees, no "free forever"
     * claims — copy-linted by `tools/check-prerender-seo.mjs`.
     */
    marketing: {
      howItWorks: {
        eyebrow: string;
        title: string;
        sub: string;
        steps: { n: string; title: string; body: string }[];
        mathNoteTitle: string;
        mathNoteBody: string;
        ctaNewBuild: string;
        ctaReno: string;
        /** Zoning cross-link card (SEO guides): why the address/zoning matters. */
        zoningCardTitle: string;
        zoningCardBody: string;
        zoningCardCta: string;
      };
      faq: {
        eyebrow: string;
        title: string;
        sub: string;
        items: { q: string; a: string }[];
      };
      /**
       * Pillar guide (SEO pillar): long-form "cost to build a house in
       * Calgary" guide at `/guides/cost-to-build-a-house-calgary`.
       * Figures are planning ranges from the cost model — never accuracy
       * claims (banned-phrase tripwire).
       */
      pillarGuide: {
        eyebrow: string;
        title: string;
        lede: string;
        tiersTitle: string;
        tiersIntro: string;
        tiers: { name: string; range: string; blurb: string }[];
        exampleTitle: string;
        exampleBody: string;
        includedTitle: string;
        includedBody: string;
        excludedTitle: string;
        excludedBody: string;
        infillTitle: string;
        infillBody: string;
        financingTitle: string;
        financingBody: string;
        faqTitle: string;
        faqs: { q: string; a: string }[];
        mathNoteTitle: string;
        mathNoteBody: string;
        ctaEstimate: string;
        ctaCommunities: string;
      };
      /**
       * Zoning explainer (SEO guides): long-form "Calgary zoning explained"
       * guide at `/guides/calgary-zoning-explained`. Zone facts follow the
       * City of Calgary Land Use Bylaw 1P2007 — no invented designations.
       */
      zoningGuide: {
        eyebrow: string;
        title: string;
        lede: string;
        introTitle: string;
        introBody: string;
        tableTitle: string;
        tableIntro: string;
        tableHeaders: { zone: string; name: string; allows: string; build: string };
        zones: { code: string; name: string; allows: string; build: string }[];
        recentTitle: string;
        recentBody: string;
        lookupTitle: string;
        lookupBody: string;
        faqTitle: string;
        /** `anchor` is optional: deep-link target for cross-page links. */
        faqs: { q: string; a: string; anchor?: string }[];
        sourceTitle: string;
        sourceBody: string;
        sourceLinkLabel: string;
        sourceUrl: string;
        verifyNote: string;
        ctaEstimate: string;
        ctaCostGuide: string;
      };
      /**
       * Community index (SEO-05). Copy for `/communities/` and the landing
       * "Browse community guides" entry card.
       */
      communities: {
        /** Landing card title: "Browse community guides". */
        landingTitle: string;
        /** Landing card body. */
        landingBody: string;
        /** Index page intro paragraph. */
        intro: string;
        /** #690: index section headings — established/infill communities first, then newer ones. */
        groups: Record<'established' | 'newer', { heading: string; body: string }>;
      };
    };
    /**
     * Builder-matching explainer (UX audit 2026-09-28). The phrases
     * "builders associated with us" / "matched builder" appear on the gate,
     * report, and FAQ — this honest, buyer-grade explainer defines them in
     * one place so every surface links the same definition. No marketplace
     * promises: Feasly is an independent estimator.
     */
    builderMatching: {
      /** Expander summary, e.g. `What does "builders associated with us" mean?` */
      summary: string;
      /** Explainer paragraphs, rendered in order. */
      paragraphs: string[];
    };
    /**
     * Consent banner (story consumer/01). All user-facing banner copy lives
     * here so the no-hardcode tripwire stays green and copy is
     * deploy-tunable. No dark patterns: accept and decline are worded as
     * equal choices.
     */
    consent: {
      title: string;
      body: string;
      accept: string;
      decline: string;
    };
    /**
     * Legal pages (legal/01). Banner copy for the draft-pending-review
     * notice shown while `legal.reviewPending` is true. Story-pinned
     * wording — do not paraphrase.
     */
    legal: {
      /** Banner heading: "Draft — pending legal review". */
      reviewBannerHeading: string;
      /** Banner body explaining the draft status. */
      reviewBannerBody: string;
    };
    /**
     * Community pages (SEO-04). Static copy for `/communities/:slug/` —
     * the per-community figures come from the build-time JSON artifacts.
     * No accuracy guarantees, no sold-price claims.
     */
    communities: {
      /** Shown when the cost data is still uncalibrated. */
      illustrativeBanner: string;
      /** Title pattern; {name} is the community display name. */
      titleTemplate: string;
      /** Meta description pattern; {name} is the community display name. */
      descriptionTemplate: string;
      statLabel: string;
      /** Guide pages: what the average is built from (single/semi-detached homes, #690). */
      statNote: string;
      /** Guide pages: label for the record count the average is built from (#690). */
      statCountLabel: string;
      /** Profile pages: what the average is built from (all residential dwellings, #690). */
      profileStatNote: string;
      basisNote: string;
      tierSectionTitle: string;
      tierSectionSub: string;
      /** Eyebrow above the hero total on each tier card. */
      totalLabel: string;
      /** Legend label for the land segment of the split bar. */
      landSplitLabel: string;
      /** Legend label for the build segment of the split bar. */
      buildSplitLabel: string;
      /**
       * aria-label template for the split bar (text equivalent, never
       * color-only). Placeholders: {land}, {landPct}, {build}, {buildPct}.
       */
      splitBarLabelTemplate: string;
      faqTitle: string;
      faqItems: { q: string; a: string }[];
      ctaTitle: string;
      ctaBody: string;
      ctaLabel: string;
      /**
       * Property-profile page variant copy (condo/apartment-dominated
       * communities). NOT in global config anymore — lives in
       * `app/features/communities/community-profile-copy.defaults.ts` and is
       * lazy-loaded with the profile variant (Lighthouse script-size budget).
       * The shape is CommunityProfileCopy in `@feasly/contracts`.
       */
      /** One-link cross-reference to the zoning explainer guide (SEO guides). */
      zoningGuideLink: string;
      /**
       * Coverage-redirect property card (guide variant): shown when the
       * estimator's coverage gate redirects a rejected property here. Same
       * comparison semantics as the property-profile variant's hero; {name}
       * is the community display name.
       */
      coverageLede: string;
      /** "This address's assessed value" label on the coverage card. */
      propertyValueLabel: string;
      /** "{name} average" — community-average label on the coverage card. */
      communityAverageLabel: string;
      /** Bar tag for the property row of the comparison bars. */
      comparePropertyTag: string;
      /** Caption under the comparison bars. */
      compareBarCaption: string;
      /**
       * aria-label template for the comparison bars (text equivalent, never
       * color-only). Placeholders: {propertyValue}, {name}, {avgAssessed}.
       */
      compareBarLabelTemplate: string;
      /** Honest note under the property value; {year} is the roll year. */
      coverageHonestNote: string;
    };
    /**
     * Builder portal wiring. Only infrastructure config lives in the root
     * config now: the Entra tenant wiring is needed at startup (the Entra
     * auth service is root-provided). All user-facing builder-portal copy
     * moved to {@link BuilderCopy} — lazy-loaded with the builder portal
     * via BUILDER_COPY so it stays out of the initial bundle.
     */
    builder: {
      /** Builder Entra tenant wiring (infrastructure, not user copy). */
      entra: BuilderEntraConfig;
    };
    /**
     * Admin funnel dashboard (story admin/07). All user-facing dashboard
     * copy lives here so the no-hardcode tripwire stays green.
     */
    admin: {
      /**
       * Admin shell (#503, portal-ui-kit §4): grouped sidebar, top bar,
       * ⌘K placeholder. Nav labels are keyed by the item ids in
       * features/admin/admin-nav.ts.
       */
      shell: {
        brand: string;
        homeLabel: string;
        navLabel: string;
        groups: { pipeline: string; partners: string; money: string; system: string };
        nav: {
          leads: string;
          estimates: string;
          builders: string;
          users: string;
          apiKeys: string;
          billing: string;
          invoices: string;
          disputes: string;
          calibration: string;
          sheets: string;
          funnels: string;
          webhooks: string;
          quarantine: string;
        };
        /** Screen-reader suffix for a queue badge, e.g. "3 open". */
        badgeSuffix: string;
        openMenu: string;
        closeMenu: string;
        collapseSidebar: string;
        expandSidebar: string;
        breadcrumbLabel: string;
        searchLabel: string;
        searchShortcut: string;
        /** `aria-keyshortcuts` for the search button. */
        searchKeyShortcuts: string;
        /** ⌘K command palette (#538). */
        palette: {
          title: string;
          placeholder: string;
          hint: string;
          loading: string;
          noResults: string;
          error: string;
          retry: string;
          close: string;
          escKey: string;
          resultsLabel: string;
          /** Keyboard hint under the results ("↑↓ to move · Enter to open"). */
          navHint: string;
          /** Group headings per hit kind. */
          kinds: { lead: string; invoice: string; builder: string; user: string };
        };
        environmentLabel: string;
        userMenuLabel: string;
        signOut: string;
      };
      /**
       * Admin Quarantine (#540): honeypot-flagged leads on their own route,
       * with row and bulk approve/discard. `{count}`, `{name}`, `{failed}`
       * and `{total}` are filled in by the page.
       */
      quarantine: {
        title: string;
        description: string;
        searchLabel: string;
        searchPlaceholder: string;
        clearFilters: string;
        countOne: string;
        countMany: string;
        tableLabel: string;
        columns: { lead: string; address: string; source: string; tenant: string; created: string };
        emptyHeading: string;
        emptyMessage: string;
        noResultsHeading: string;
        noResultsMessage: string;
        errorHeading: string;
        loadError: string;
        retry: string;
        loading: string;
        actionsHeader: string;
        loadMore: string;
        loadingMore: string;
        selectAll: string;
        selectRow: string;
        selectedCount: string;
        approve: string;
        approving: string;
        discard: string;
        discarding: string;
        approveSelected: string;
        discardSelected: string;
        cancel: string;
        approveConfirmTitleMany: string;
        approveConfirmBody: string;
        discardConfirmTitle: string;
        discardConfirmTitleMany: string;
        discardConfirmBody: string;
        approvedOne: string;
        approvedMany: string;
        discardedOne: string;
        discardedMany: string;
        failedOne: string;
        failedMany: string;
        dismiss: string;
      };
      /**
       * Admin Leads (#539, admin review S5/S6): saved views, the kit
       * DataTable and the lead drawer with one footer Save.
       */
      leads: {
        title: string;
        description: string;
        sandboxToggle: string;
        exportCsv: string;
        exporting: string;
        dismiss: string;
        totalsLabel: string;
        viewsLabel: string;
        /** Saved views. `quotingStale` takes `{days}`. */
        views: { all: string; new: string; unassigned: string; quotingStale: string };
        /** One-line explanation under the views, per view. `quotingStale` takes `{days}`. */
        viewHints: { all: string; new: string; unassigned: string; quotingStale: string };
        searchLabel: string;
        searchPlaceholder: string;
        statusFilter: string;
        anyStatus: string;
        assignedFilter: string;
        anyAssignment: string;
        unassigned: string;
        clearFilters: string;
        /** "{count} leads". */
        countOne: string;
        countMany: string;
        sandboxExcluded: string;
        tableLabel: string;
        columns: {
          lead: string;
          address: string;
          status: string;
          tenant: string;
          source: string;
          score: string;
          timeline: string;
          consent: string;
          created: string;
        };
        consentIn: string;
        consentOut: string;
        sandboxBadge: string;
        emptyHeading: string;
        emptyMessage: string;
        noResultsHeading: string;
        noResultsMessage: string;
        errorHeading: string;
        retry: string;
        loading: string;
        actionsHeader: string;
        loadMore: string;
        loadingMore: string;
        drawer: {
          loading: string;
          refreshing: string;
          retry: string;
          close: string;
          cancel: string;
          save: string;
          saving: string;
          /** Toast after a successful save. */
          saved: string;
          readOnlyHint: string;
          sections: {
            pipeline: string;
            contact: string;
            property: string;
            invoices: string;
            notes: string;
            comments: string;
            activity: string;
            record: string;
          };
          statusLabel: string;
          builderLabel: string;
          unassigned: string;
          labels: {
            email: string;
            phone: string;
            source: string;
            tenant: string;
            magicLink: string;
            contactConsent: string;
            marketingConsent: string;
            address: string;
            projectType: string;
            livingArea: string;
            finishTier: string;
            totalRange: string;
            buildRange: string;
            land: string;
            estimated: string;
            leadScore: string;
            consented: string;
            sheetsSynced: string;
            snapshots: string;
            unsubscribed: string;
            nudgeSent: string;
          };
          /** "{sqft} sq ft". */
          sqftValue: string;
          yes: string;
          no: string;
          magicLink: { sent: string; used: string; expired: string; none: string };
          openEstimate: string;
          noEstimate: string;
          invoicesHint: string;
          openInvoices: string;
          noNotes: string;
          addNoteLabel: string;
          addNotePlaceholder: string;
          addNote: string;
          addingNote: string;
          notesHint: string;
          commentsHint: string;
          noActivity: string;
          honeypotBadge: string;
        };
      },
      /** EntityLink + "Technical IDs" copy shared by admin pages (#538). */
      entities: {
        technicalIds: string;
        copyId: string;
        idCopied: string;
        /** Link text when a record has no human label in the payload. */
        viewLead: string;
        viewInvoice: string;
        /** Disclosure label for an audit event's raw JSON payload. */
        rawPayload: string;
      };
      funnels: {
        /** Page heading. */
        title: string;
        /** Page subheading. */
        subtitle: string;
        /** Date-range "from" label. */
        fromLabel: string;
        /** Date-range "to" label. */
        toLabel: string;
        /** Tenant filter label. */
        tenantLabel: string;
        /** Tenant filter: all traffic. */
        tenantAll: string;
        /** Tenant filter: Feasly-direct only. */
        tenantDirect: string;
        /** Tenant filter: one embed tenant. */
        tenantKey: string;
        /** Tenant-key text input label. */
        tenantKeyLabel: string;
        /** Tenant-key text input placeholder. */
        tenantKeyPlaceholder: string;
        /** Apply-filters button. */
        apply: string;
        /** Reset-filters button. */
        reset: string;
        /** Loading indicator text. */
        loading: string;
        /** Empty funnel state. */
        empty: string;
        /** Fetch failure banner (static — no error detail in the DOM). */
        loadError: string;
        /** Invalid date range (from after to). */
        invalidRange: string;
        /** First-step conversion label. */
        entryStep: string;
        /** Conversion prefix before the percentage. */
        conversionPrefix: string;
        /** Shown when conversion is meaningless (first step / zero prior). */
        noConversion: string;
        /** Accessible name of the date-preset button group. */
        presetsLabel: string;
        /** Date presets: label + trailing day count (today inclusive). */
        presets: ReadonlyArray<{ readonly label: string; readonly days: number }>;
        /** Date preset that clears both dates. */
        presetAll: string;
        /** KPI label: entry → final step conversion. */
        overallConversion: string;
        /** KPI sub line under the overall conversion; `{from}`/`{to}` = step labels. */
        overallConversionSub: string;
        /** Drop-off annotation; `{count}` = people lost since the previous step. */
        dropOff: string;
        /** Accessible name of the funnel step list. */
        stepsLabel: string;
      };
      /** Admin API keys (api-mcp/02; redesign #546, review S13). */
      apiKeys: {
        title: string;
        subtitle: string;
        issueButton: string;
        /** DataTable. */
        tableLabel: string;
        colName: string;
        colBuilder: string;
        colPrefix: string;
        colScopes: string;
        colLastUsed: string;
        colStatus: string;
        never: string;
        noBuilder: string;
        sandboxChip: string;
        openKey: string;
        empty: string;
        emptyMessage: string;
        loadError: string;
        loadErrorMessage: string;
        retry: string;
        /** Key drawer. */
        tabsLabel: string;
        tabOverview: string;
        tabUsage: string;
        builderLabel: string;
        prefixLabel: string;
        modeLabel: string;
        modeLive: string;
        modeSandbox: string;
        createdLabel: string;
        lastUsedLabel: string;
        revokedAtLabel: string;
        accessHeading: string;
        accessHint: string;
        revokedNote: string;
        scopesLabel: string;
        scopesError: string;
        rateLimitLabel: string;
        rateLimitHint: string;
        rateLimitError: string;
        saveButton: string;
        savedToast: string;
        saveError: string;
        closeButton: string;
        dangerHeading: string;
        rotateHint: string;
        revokeHint: string;
        rotateButton: string;
        revokeButton: string;
        rotateConfirmTitle: string;
        rotateConfirm: string;
        revokeConfirmTitle: string;
        revokeConfirm: string;
        cancelButton: string;
        revokedToast: string;
        actionError: string;
        /** Usage tab. */
        usageChartLabel: string;
        usageTotal: string;
        usageShowTable: string;
        usageLoading: string;
        usageEmpty: string;
        usageDateHeader: string;
        usageEndpointHeader: string;
        usageRequestsHeader: string;
        usageEstimatesHeader: string;
        /** Issue modal. */
        issueTitle: string;
        nameLabel: string;
        namePlaceholder: string;
        nameError: string;
        builderPlaceholder: string;
        builderHint: string;
        builderEmpty: string;
        sandboxLabel: string;
        sandboxHint: string;
        createButton: string;
        issueError: string;
        /** One-time secret modal. */
        secretTitle: string;
        plaintextWarning: string;
        secretLabel: string;
        copyButton: string;
        copiedButton: string;
        copyFailed: string;
        ackLabel: string;
        doneButton: string;
      };
      /**
       * Admin auth pages (auth/02 pivot): Entra sign-in + callback copy.
       * All user-facing strings live here so the no-hardcode tripwire
       * stays green and copy is deploy-tunable. Exact strings are pinned
       * by the login/callback specs.
       */
      auth: {
        /** Session-expired notice on the login page. */
        loginExpired: string;
        /** Label of the Entra "Sign in →" button. */
        entraSignInLabel: string;
        /** Intro line above the Entra button. */
        entraSignInIntro: string;
        /**
         * Callback failure when Entra reports `error=access_denied`
         * (user cancelled) or the callback carries no usable code.
         */
        entraIncomplete: string;
        /** Callback failure when the `state` param mismatches (CSRF). */
        entraStateMismatch: string;
        /** Network/5xx failure exchanging the code with the backend. */
        entraTransient: string;
        /** Shown when the Entra tenant config is still a placeholder. */
        entraNotConfigured: string;
      };
    };
    /**
     * Unsubscribe center (email/03) copy. The confirmation line
     * `doneHeading` is pinned by the story's acceptance criteria.
     */
    unsubscribe: {
      loadingLabel: string;
      preferencesHeading: string;
      preferencesBody: string;
      emailToggleLabel: string;
      emailToggleBody: string;
      contactToggleLabel: string;
      contactToggleBody: string;
      unsubscribeAllCta: string;
      saveCta: string;
      savingLabel: string;
      doneHeading: string;
      doneEmailsOff: string;
      doneEmailsOn: string;
      doneCallsOff: string;
      doneCallsOn: string;
      doneMagicLinkNote: string;
      resubscribePrompt: string;
      resubscribeBody: string;
      expiredHeading: string;
      expiredBody: string;
      expiredCta: string;
      invalidHeading: string;
      invalidBody: string;
      errorHeading: string;
      errorBody: string;
      retryLabel: string;
      homeCta: string;
    };
    /**
     * Magic-link redemption page (`/r/:token`, consumer/02) copy. All
     * user-facing strings live here so the no-hardcode tripwire stays green.
     * Partner-share tokens use the same `/r/` URL shape and verify on
     * GET /api/v1/shares/verify — the owner verify endpoint answers
     * invalid for them, and the page falls through to the partner path.
     */
    magicLink: {
      loadingLabel: string;
      invalidHeading: string;
      invalidBody: string;
      expiredHeading: string;
      expiredBody: string;
      errorHeading: string;
      errorBody: string;
      retryLabel: string;
      homeCta: string;
      resendPrompt: string;
      resendEmailLabel: string;
      resendEmailPlaceholder: string;
      resendEmailError: string;
      resendCta: string;
      resendingLabel: string;
      resendDoneHeading: string;
      resendDoneBody: string;
      resendErrorBody: string;
    };
    /**
     * `/my-report` (#704): returning users ask for a fresh report link by
     * email. Reuses POST /api/v1/magic-link/reissue; the sent state is the
     * same whether or not the email is known (no address oracle).
     */
    myReport: {
      heading: string;
      body: string;
      emailLabel: string;
      emailPlaceholder: string;
      emailError: string;
      cta: string;
      sendingLabel: string;
      sentHeading: string;
      /** Neutral: identical for known and unknown emails. */
      sentBody: string;
      /** HTTP 429 from the reissue endpoint. */
      rateLimitedBody: string;
      errorBody: string;
      homeCta: string;
    };
    /**
     * Returning-user entry points, same-device resume chip and link sharing
     * on the report (#704).
     */
    returning: {
      /** Lead-in under the landing address box. */
      findReportPrompt: string;
      /** Link text to `/my-report` (landing, mobile nav, footer). */
      findReportLink: string;
      /** Resume chip: `{address}` is replaced with the stored address. */
      resumeLabel: string;
      /** Accessible name of the chip's dismiss button. */
      resumeDismissLabel: string;
      /** Report action row: copy the share link. */
      copyLinkCta: string;
      /** Announced (role=status) after a successful copy. */
      copyLinkDone: string;
      copyLinkError: string;
      /** Native share sheet button (shown only where navigator.share exists). */
      nativeShareCta: string;
      /** What the shared link opens (an address preview, never the owner link). */
      shareLinkHint: string;
      /** navigator.share title. */
      shareTitle: string;
      /** navigator.share text: `{address}` is replaced. */
      shareText: string;
    };
  };
}
