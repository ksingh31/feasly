import { Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { BuilderPartner } from '@feasly/contracts';
import { ConfigService } from '../../../core/config/config.service';

/**
 * PartnerDisclosure (#918): "Leads from Feasly's site go to our builder
 * partner(s): <names linked>" — shown at every lead capture point on
 * Feasly's own site. Presentational: the page reads `PartnersState` and
 * passes the list in. Until the list is available (or if it fails) it
 * points to the How it works partners section, so the disclosure never
 * disappears. Embeds never render it (the page decides).
 */
@Component({
  selector: 'app-partner-disclosure',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './partner-disclosure.component.html',
  styleUrl: './partner-disclosure.component.scss',
})
export class PartnerDisclosureComponent {
  /** Active partners in display order (empty until loaded). */
  readonly partners = input<readonly BuilderPartner[]>([]);

  protected readonly copy = inject(ConfigService).get('copy').partners;
}
