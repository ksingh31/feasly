import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type { BuilderBillingOverviewResponse, CardOnFileStatus } from '@feasly/contracts';
import {
  DataTableComponent,
  type DataTableColumn,
  ErrorStateComponent,
  KpiGridComponent,
  KpiTileComponent,
  PageHeaderComponent,
  PageLayoutComponent,
  SkeletonComponent,
  StepperComponent,
  type StepperModel,
  UiButtonComponent,
  type StatusTone,
  UiCellDirective,
  enumLabel,
  invoiceStepperModel,
} from '@app/shared/ui';
import type { BuilderCopy } from '../../core/config/app-config';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { formatCentsToWholeCad, formatRatePercent } from '../../shared/utils/money';
import { formatEdmontonMediumDate } from '../../shared/utils/edmonton';
import { BUILDER_COPY } from './builder-copy';
import { CHARGE_TIMING_COPY } from './builder-copy.defaults';
import { LoadBillingOverview } from './builder-billing.actions';
import { BuilderBillingState } from './builder-billing.state';
import { LoadInvoices } from './builder-invoices.actions';
import { BuilderInvoicesState } from './builder-invoices.state';
import type { BuilderCommissionInvoice } from './builder-invoices-api.service';
import { injectCardModal } from './builder-card-modal.component';

/** One KPI tile, display-ready (all figures formatted from API cents). */
export interface MoneyKpi {
  readonly key: 'outstanding' | 'next' | 'failed' | 'plan';
  readonly label: string;
  readonly value: string;
  readonly sub: string;
  readonly tone?: StatusTone;
  /** Router link the tile opens; plain tile when absent. */
  readonly link?: string;
}

/** Card panel view model. */
export interface MoneyCardPanel {
  /** "Visa •••• 4242", or null when no card is saved / flat plan. */
  readonly title: string | null;
  readonly expiry: string | null;
  readonly body: string | null;
  /** Card modal button label; null under a flat plan. */
  readonly action: string | null;
}

/** "08/28" from month 8 / year 2028; null when either part is missing. */
export function cardExpiry(card: CardOnFileStatus | null | undefined): string | null {
  if (!card?.expMonth || !card.expYear) {
    return null;
  }
  const mm = String(card.expMonth).padStart(2, '0');
  const yy = String(card.expYear).slice(-2);
  return `${mm}/${yy}`;
}

/**
 * Builder Money page (#532, artboard "Builder · Money"): `/builder/money`.
 *
 * - KPI tiles from one overview call (#531): outstanding balance, next
 *   auto-charge, failed payments, plan + configured rate.
 * - Recent invoices in the kit DataTable — status chips from the shared
 *   status dictionary and the invoice lifecycle stepper (Issued → Review
 *   window → Charged → Paid). Below 768px the table renders as cards.
 * - Card-on-file panel and a "How charges work" panel carrying the one
 *   owner-approved charge-timing sentence, plus a "Question an invoice"
 *   link (deploy-configured href; hidden when unset).
 *
 * Every figure is integer cents from the API, only formatted here. State
 * lives in BuilderBillingState / BuilderInvoicesState.
 */
@Component({
  selector: 'app-builder-money',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    DataTableComponent,
    ErrorStateComponent,
    KpiGridComponent,
    KpiTileComponent,
    PageHeaderComponent,
    PageLayoutComponent,
    SkeletonComponent,
    StepperComponent,
    UiButtonComponent,
    UiCellDirective,
  ],
  templateUrl: './builder-money.component.html',
  styleUrl: './builder-money.component.scss',
})
export class BuilderMoneyComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly config = inject(ConfigService);
  private readonly openCardModal = injectCardModal();

  protected readonly copy = inject(BUILDER_COPY);
  /** The one owner-approved charge-timing sentence (#479). */
  protected readonly chargeTiming = CHARGE_TIMING_COPY;

  protected readonly overview = this.store.selectSignal(BuilderBillingState.overview);
  protected readonly overviewStatus = this.store.selectSignal(BuilderBillingState.overviewStatus);
  protected readonly invoices = this.store.selectSignal(BuilderInvoicesState.invoices);
  protected readonly listStatus = this.store.selectSignal(BuilderInvoicesState.listStatus);

  /** Deploy-configured "Question an invoice" destination; '' hides the link. */
  protected readonly questionHref = this.config.get('billing').questionInvoiceHref;

  protected readonly kpis = computed<readonly MoneyKpi[]>(() => {
    const o = this.overview();
    return o ? buildKpis(o, this.copy) : [];
  });

  protected readonly cardPanel = computed<MoneyCardPanel | null>(() => {
    const o = this.overview();
    if (!o) {
      return null;
    }
    if (o.planType === 'flat' || o.card === null) {
      return { title: null, expiry: null, body: this.copy.moneyCardFlat, action: null };
    }
    if (!o.card.hasCard) {
      return { title: null, expiry: null, body: this.copy.moneyCardNone, action: this.copy.moneyCardAdd };
    }
    const exp = cardExpiry(o.card);
    return {
      title: [enumLabel(o.card.brand), '••••', o.card.last4 ?? '—'].join(' '),
      expiry: exp ? this.copy.moneyCardExpires.replace('{exp}', exp) : null,
      body: null,
      action: this.copy.moneyCardManage,
    };
  });

  protected readonly columns: readonly DataTableColumn<BuilderCommissionInvoice>[] = [
    { key: 'invoiceNumber', header: this.copy.invoicesColInvoiceNumber, kind: 'id', cardRole: 'title' },
    { key: 'leadName', header: this.copy.invoicesColLead, cardRole: 'meta' },
    { key: 'commissionCents', header: this.copy.invoicesColCommission, kind: 'money', cardRole: 'meta' },
    { key: 'status', header: this.copy.invoicesColStatus, kind: 'status', statusDomain: 'invoice', cardRole: 'chip' },
    { key: 'reviewDueAt', header: this.copy.moneyColReviewEnds, kind: 'date', cardRole: 'meta' },
    { key: 'lifecycle', header: this.copy.moneyColLifecycle, value: (row) => row.status, cardRole: 'hidden' },
  ];

  protected readonly rowId = (row: BuilderCommissionInvoice): string => row.id;

  protected readonly listError = computed(() =>
    this.listStatus() === 'error' ? this.copy.invoicesLoadError : null,
  );

  constructor() {
    inject(SeoService).setPage({
      title: 'Money — Feasly builder portal',
      description: this.copy.moneySeoDescription,
      path: '/builder/money',
    });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadBillingOverview());
    this.store.dispatch(new LoadInvoices(1));
  }

  protected retryOverview(): void {
    this.store.dispatch(new LoadBillingOverview());
  }

  protected retryInvoices(): void {
    this.store.dispatch(new LoadInvoices(1));
  }

  protected stepper(status: string): StepperModel {
    return invoiceStepperModel(status);
  }

  /** Row click / Enter: open the invoice detail on the Invoices page. */
  protected openInvoice(row: BuilderCommissionInvoice): void {
    void this.router.navigate(['/builder/invoices'], { queryParams: { invoice: row.id } });
  }

  /** Card panel action: add/update the card in the shared modal (#534). */
  protected openCard(): void {
    this.openCardModal(this.overview()?.card ?? undefined);
  }

  protected openKpi(kpi: MoneyKpi): void {
    if (kpi.link) {
      void this.router.navigateByUrl(kpi.link);
    }
  }
}

/** Display-ready KPI tiles from the overview. Pure: formatting only. */
export function buildKpis(
  o: BuilderBillingOverviewResponse,
  copy: BuilderCopy,
): readonly MoneyKpi[] {
  const next = o.nextCharge;
  const nextDate = next ? formatEdmontonMediumDate(next.chargeAt) : '';
  const commission = o.planType === 'commission';
  // #764: outstanding and next-charge amounts include tax (server-summed);
  // say so when tax is on. Untaxed builders see the labels unchanged.
  const inclTax = (label: string): string =>
    o.tax ? copy.moneyKpiInclTax.replace('{label}', label).replace('{tax}', o.tax.label) : label;
  return [
    {
      key: 'outstanding',
      label: inclTax(copy.moneyKpiOutstanding),
      value: formatCentsToWholeCad(o.outstandingCents),
      sub:
        o.outstandingCount === 1
          ? copy.moneyKpiOutstandingSubOne
          : copy.moneyKpiOutstandingSub.replace('{count}', String(o.outstandingCount)),
    },
    {
      key: 'next',
      label: inclTax(copy.moneyKpiNextCharge),
      value: next ? formatCentsToWholeCad(next.amountCents) : copy.moneyKpiNextChargeNone,
      sub: !next
        ? copy.moneyKpiNextChargeNoneSub
        : next.cardLast4
          ? copy.moneyKpiNextChargeSub.replace('{date}', nextDate).replace('{last4}', next.cardLast4)
          : copy.moneyKpiNextChargeSubNoCard.replace('{date}', nextDate),
      tone: next ? 'warning' : undefined,
    },
    {
      key: 'failed',
      label: copy.moneyKpiFailed,
      value: String(o.failedCount),
      sub: o.failedCount > 0 ? copy.moneyKpiFailedSub : copy.moneyKpiFailedNoneSub,
      tone: o.failedCount > 0 ? 'danger' : undefined,
      link: o.failedCount > 0 ? '/builder/billing' : undefined,
    },
    {
      key: 'plan',
      label: copy.moneyKpiPlan,
      value: !commission
        ? copy.moneyPlanFlat
        : o.commissionRatePercent !== null
          ? copy.moneyPlanCommission.replace('{rate}', formatRatePercent(o.commissionRatePercent))
          : enumLabel(o.planType),
      sub: commission ? copy.moneyPlanCommissionSub : copy.moneyPlanFlatSub,
    },
  ];
}
