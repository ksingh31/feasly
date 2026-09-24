import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConfigService } from '../../../core/config/config.service';

/**
 * Site nav (FE1-001): slim dark bar with the brand mark. The prototype's
 * "Sign in" button is intentionally omitted — magic-link auth is unconfirmed
 * and a button to nowhere would be a dead end. Revisit when auth lands.
 */
@Component({
  selector: 'app-site-nav',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './site-nav.component.html',
  styleUrl: './site-nav.component.scss',
})
export class SiteNavComponent {
  protected readonly siteName = inject(ConfigService).get('site').name;
}
