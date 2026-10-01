import type { BuilderCopy } from '../../core/config/app-config';

/**
 * Default user-facing builder-portal copy. Lazy-loaded with the builder
 * portal (provided as BUILDER_COPY at the builder routes) so the initial
 * bundle doesn't carry it. Deploy-time overrides live in
 * `/assets/config/app-config.json` under `copy.builder` and are merged
 * over these defaults by provideBuilderCopy().
 *
 * The Entra tenant wiring is NOT here — it stays in the root
 * DEFAULT_APP_CONFIG (`copy.builder.entra`) because the Entra auth
 * service is root-provided and needs it before any builder route loads.
 */
export const DEFAULT_BUILDER_COPY: BuilderCopy = {
      loginHeading: 'Builder sign in',
      loginExpired:
    'Your builder session expired. Please sign in again with your Microsoft account.',
  emailInvalid: 'Enter a valid email address.',
  retryLabel: 'Retry',
  shellBrand: 'Feasly Builder',
  shellNavDashboard: 'Leads',
  signOutLabel: 'Sign out',
  dashboardHeading: 'Lead pipeline',
  loadingLeads: 'Loading your leads…',
  loadError: 'Could not load your leads. Please try again.',
  emptyLeads: 'No leads yet — new Feasly leads will appear here.',
  filterLabel: 'Filter by status',
  filterAllLabel: 'All statuses',
  emptyFilterLeads: 'No leads with this status yet.',
  summaryHeading: 'Pipeline summary',
  summaryTotal: 'Total leads',
  statusLabels: {
    new: 'New',
    contacted: 'Contacted',
    quoted: 'Quoted',
    won: 'Won',
    lost: 'Lost',
  },
  updateForbidden:
    'That lead belongs to another builder — its status was not changed.',
  updateFailed: 'Could not update the lead status. Please try again.',
  leadEmailLabel: 'Email',
  leadAddressLabel: 'Address',
  leadPhoneLabel: 'Phone',
  leadTimelineLabel: 'Timeline',
  leadScoreLabel: 'Lead score',
  leadProjectLabel: 'Project',
  leadCreatedLabel: 'Created',
  leadStatusUpdatedLabel: 'Status updated',
  actionsLabel: 'Update lead status',
  shellNavBilling: 'Billing',
  shellNavInvoices: 'Invoices',
  shellNavReportContract: 'Record signed contract',
  reportContractSeoDescription:
    'Record a signed build contract in the Feasly builder portal.',
  reportContractHeading: 'Record a signed contract',
  reportContractExplainer:
    'When a Feasly lead signs a build contract, record it here. We take a {rate} commission on the signed contract value, excluding land. Please record it within 14 days of signing — that’s part of your Feasly agreement.',
  reportContractLeadLabel: 'Which lead signed?',
  reportContractLeadRequired: 'Choose the lead that signed the contract.',
  reportContractLeadsLoading: 'Loading your leads…',
  reportContractLeadsError:
    'We couldn’t load your leads. Please try again.',
  reportContractLeadsEmpty:
    'You don’t have any leads yet. Once Feasly sends you leads, you can record signed contracts here.',
  recordContractNoReportableLeads:
    'Every lead already has a recorded contract — nothing left to record.',
  recordContractAlreadyRecordedTitle: 'This contract is already recorded',
  recordContractAlreadyRecordedBody:
    'There’s already a commission invoice for this lead. Review it for the current amount and payment timing.',
  reportContractValueLabel: 'Contract value (CAD, excluding land)',
  reportContractValueHint:
    'The signed construction contract amount — land cost stays out. Example: 650000',
  reportContractValueRequired: 'Enter the contract value.',
  reportContractValueInvalid: 'Enter a valid amount, like 650000.',
  reportContractDateLabel: 'Date the contract was signed',
  reportContractDateRequired: 'Enter the signing date.',
  reportContractDateFuture: 'The signing date can’t be in the future.',
  reportContractSubmit: 'Record signed contract',
  reportContractSubmitting: 'Recording…',
  reportContractSuccessTitle: 'Contract recorded — your invoice is ready',
  reportContractSuccessBody:
    'You recorded a {amount} contract. Your {rate} commission is {commission}. The invoice is in its 7-day review window — we’ll charge your card on file after the review and email you a receipt.',
  reportContractAlreadyReported:
    'This contract is already recorded — nothing more to do.',
  reportContractDisputed:
    'This contract already has an invoice under dispute. The charge is paused while we review it — nothing more for you to do.',
  reportContractFlatCovered:
    'You’re on the flat plan, so this contract is already covered — no commission is due.',
  reportContractNotEnabled:
    'Billing isn’t enabled for your account yet. We saved your report and our team will follow up.',
  reportContractAwaitingDetails:
    'We received your report but need more details before we can create the invoice. Our team will follow up.',
  recordContractViewInvoice: 'View invoice',
  recordContractBackToLeads: 'Back to leads',
  recordContractReviewDeadline: 'Review deadline',
  recordContractAutoCharge: 'Auto-charges',
  recordContractZeroCommission: '$0.00',
  billingHeading: 'Billing',
  billingLoading: 'Loading your billing details…',
  billingLoadError: 'We couldn’t load your billing details. Please try again.',
  billingNoCard: 'No card on file.',
  billingCardOnFile: 'Card on file: {brand} •••• {last4}, expires {exp}',
  billingAddCard: 'Add card',
  billingUpdateCard: 'Update card',
  billingFormHeading: 'Card details',
  billingSaveCard: 'Save card',
  billingSavingCard: 'Saving…',
  billingCardSaved:
    'Card saved — we’ll charge this card after each 7-day review window.',
  billingSaveFailed:
    'We couldn’t save your card. Check the details and try again.',
  billingUnavailable:
    'Card setup isn’t available yet — please contact us to arrange billing.',
  billingCancel: 'Cancel',
  billingExplainer:
    'When you record a signed contract, Feasly creates a commission invoice for your agreed rate on the signed contract value, excluding land. The invoice auto-charges 7 days later unless disputed.',
  invoicesHeading: 'Invoices',
  invoicesExplainer:
    'Every commission invoice on your account, newest first. Each invoice shows the commission rate applied to the signed contract value, excluding land.',
  invoicesLoading: 'Loading your invoices\u2026',
  invoicesLoadError:
    'We couldn\u2019t load your invoices. Please try again.',
  invoicesEmpty:
    'No invoices yet — they’ll appear here when you record a signed contract.',
  invoicesColDate: 'Date',
  invoicesColContract: 'Contract value',
  invoicesColCommission: 'Commission',
  invoicesColStatus: 'Status',
  invoicesColDue: 'Review deadline',
  invoicesColLead: 'Lead',
  invoiceStatusDraft: 'Draft',
  invoiceStatusInReview: 'In review',
  invoiceStatusFinalized: 'Finalized',
  invoiceStatusPaid: 'Paid',
  invoiceStatusFailed: 'Failed',
  invoiceStatusDisputed: 'Disputed',
  invoiceStatusVoid: 'Void',
  invoicesAutoChargeIn: 'Auto-charges in {days} days',
  invoicesAutoChargeTomorrow: 'Auto-charges tomorrow',
  invoicesAutoChargeToday: 'Auto-charges today',
  invoicesPaymentFailed:
    'Your card was declined \u2014 update it to avoid collection.',
  invoicesPaymentReceived: 'Payment received \u2014 thank you.',
  invoicesUpdateCardCta: 'Update your card',
  invoicesBackToList: 'Back to invoices',
  invoicesReceiptHeading: 'Receipt',
  invoicesLineItemsHeading: 'Invoice details',
  invoicesTimelineHeading: 'Status timeline',
  invoicesContractRow: 'Signed contract value (excl. land)',
  invoicesCommissionRow: 'Commission ({rate})',
  invoicesReceiptAmount: 'Amount charged',
  invoicesReceiptDate: 'Charge date',
  invoicesReceiptCard: 'Card used',
  invoicesReviewNote:
    'The 7-day review window ends {date}. The card on file is charged automatically unless the invoice is disputed through the admin console.',
  invoicesPrevPage: 'Previous',
  invoicesNextPage: 'Next',
  invoicesPageOf: 'Page {page} of {pages}',
  invoicesPage: 'Page {page}',
  invoicesPageSize: 10,
  invoicesSeoDescription:
    'Commission invoices for your Feasly builder account.',
  invoicesTimelineCreated: 'Invoice created',
  invoicesTimelineReviewEnds: 'Review window ends',
  invoicesTimelineFinalized: 'Finalized',
  invoicesTimelinePaid: 'Paid',
  invoicesTimelineFailed: 'Charge failed',
  entraSignInLabel: 'Sign in with Microsoft →',
  entraSignInIntro:
    'Sign in with your work email to access your builder portal.',
  entraRedirecting: 'Redirecting to Microsoft sign-in…',
  entraNotConfigured:
    'Builder sign-in is not configured yet — please contact us.',
  entraCallbackVerifying: 'Completing sign in…',
  entraCallbackCancelled: "Sign-in didn't complete — try again.",
  entraCallbackStateMismatch: "Sign-in didn't complete — try again.",
  entraCallbackTransient: 'Something went wrong. Please try again.',
  entraCallbackBackToLogin: 'Back to sign in',
  orgPickerHeading: 'Choose your organization',
  orgPickerIntro:
    'You belong to more than one builder organization. Pick the one you want to work in — you can switch anytime.',
  orgPickerLoading: 'Loading your organizations…',
  orgPickerError: 'Could not load your organizations. Please try again.',
  orgPickerRetry: 'Retry',
  orgSwitcherLabel: 'Organization',
  orgRoleAdmin: 'Administrator',
  orgRoleMember: 'Member',
  teamNavLabel: 'Team',
  teamHeading: 'Team',
  teamIntro:
    'Invite people to your organization and manage who can access it. Only administrators can change team settings.',
  teamLoading: 'Loading your team…',
  teamLoadError: 'Could not load your team. Please try again.',
  teamRetry: 'Retry',
  teamEmpty: 'No team members yet — invite your first teammate below.',
  teamColName: 'Name',
  teamColEmail: 'Email',
  teamColRole: 'Role',
  teamApplyRole: 'Apply',
  teamColStatus: 'Status',
  teamColActions: 'Actions',
  teamStatusActive: 'Active',
  teamStatusInvited: 'Invited',
  teamStatusDeactivated: 'Deactivated',
  teamInviteHeading: 'Invite a teammate',
  teamInviteNameLabel: 'Full name',
  teamInviteNameInvalid: 'Enter their name.',
  teamInviteEmailLabel: 'Work email',
  teamInviteRoleLabel: 'Role',
  teamInviteSubmit: 'Send invite',
  teamInviteSending: 'Sending…',
  teamInviteSent:
    'Invite sent — they will get an email to set up their sign-in.',
  teamInviteError: 'Could not send the invite. Please try again.',
  teamInviteDuplicateMember: 'This email is already on the team.',
  teamInviteDuplicatePending:
    'An invite is already on its way to this email address.',
  teamDeactivateLabel: 'Deactivate',
  teamReactivateLabel: 'Reactivate',
  teamRemoveLabel: 'Remove',
  teamRemoving: 'Removing…',
  teamDeactivating: 'Deactivating…',
  // auth/07: exact story copy — shown under the disabled controls when
  // the row is the sole remaining active admin.
  teamLastAdminRoleNote:
    "You can't change the role of the last administrator. Add another administrator first.",
  teamLastAdminDeactivateNote:
    'Every organization needs at least one active administrator.',
  teamDeactivateConfirm:
    'Deactivate {name}? They will lose access to the builder portal immediately and be signed out.',
  teamRemoveConfirm:
    'Remove the invite for {name}? They have not signed in yet, so this just cancels the invitation.',
  teamConfirmYes: 'Yes, continue',
  teamConfirmNo: 'Cancel',
  teamActionError: 'Something went wrong. Please try again.',
  // Builder-side view-as (2026-09-30, Karan): a builder_admin sees the
  // portal exactly as a team member sees it — "View as" on each eligible
  // row (active members only; never other admins, never yourself).
  teamViewAsLabel: 'View as',
  teamViewAsStarting: 'Starting…',
  teamViewAsError: 'Could not start viewing as this member. Please try again.',
  teamViewAsForbidden: 'Only administrators can view as a team member.',
  shellHomeLabel: 'Feasly Builder home',
  shellMenuOpenLabel: 'Open menu',
  shellMenuCloseLabel: 'Close menu',
  leadsSubtitle: 'Your matched homeowners, from first contact to signed contract.',
  leadsEmptyHeading: 'No leads yet',
  leadsEmptyGuidance:
    'Matched homeowners will appear here as soon as they submit an estimate request.',
  leadsFilterEmptyHeading: 'No leads with this status',
  leadsFilterEmptyGuidance:
    'Try a different status, or clear the filter to see every lead.',
  leadsErrorHeading: "Couldn't load your leads",
  leadsClearFilter: 'Clear filter',
  leadsStatusControlLabel: 'Update status for {name}',
  leadsStatusSaving: 'Saving…',
  leadsStatusApply: 'Apply',
  leadsStatusLocked: 'Status locked — contract recorded',
  commentsSectionTitle: 'Notes',
  commentsAddFirstNote: 'Add the first note',
  commentsEmptyHint:
    'No notes yet. Jot down call outcomes, site-visit details, or anything the next person should know.',
  commentsVisibleToOrg: 'Visible to your organization',
  commentsTeamBadge: 'Feasly team',
  commentsEmpty: 'No notes yet — add the first one below.',
  commentsPostFailed: 'Could not post your note. Please try again.',
  commentsEditFailed: 'Could not save your edit. Please try again.',
  commentsMaxLength: 2000,
  leadsWonHint: 'Signed a contract with this lead?',
  leadsWonReportCta: 'Record the signed contract',
  leadsRecordedCta: 'Contract recorded',
  leadsViewInvoiceCta: 'View your invoice',
  teamColAdded: 'Added',
  teamInviteButton: 'Invite team member',
  teamInviteModalSub:
    'They’ll get an email invite and sign in with their Microsoft account — Feasly never sees a password.',
  teamCountOne: '1 team member',
  teamCountMany: 'team members',
  teamNotAdmin: 'Only organization administrators can manage the team.',
  /**
   * Builder billing redesign (design pass, 2026-09-28). Card-on-file
   * panel copy in the admin billing design language.
   */
  billingCardPanelTitle: 'Card on file',
  billingCardBrandLabel: 'Brand',
  billingCardNumberLabel: 'Card number',
  billingCardExpiryLabel: 'Expires',
  billingCardEmptyTitle: 'No card on file.',
  billingCardEmptyBody:
    'Commission invoices auto-charge 7 days after each review window. Add a card so charges go through.',
  contractWhatHappensTitle: 'What happens next',
  contractFormHeading: 'Record details',
  contractLeadPlaceholder: 'Select a lead…',
  contractEstimatedCommission: 'Your commission ({rate})',
  contractCommissionPanelSub:
    'Calculated from the signed contract value, excluding land.',
  contractCommissionContractValue: 'Contract value',
  contractCommissionRate: 'Commission rate',
  contractRetry: 'Try again',
};
