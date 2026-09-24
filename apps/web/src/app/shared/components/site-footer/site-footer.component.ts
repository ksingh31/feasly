import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConfigService } from '../../../core/config/config.service';

/**
 * Site footer (FE1-001): slim dark footer with Privacy/Terms links.
 * The routes exist (minimal honest pages) — no dead ends.
 */
@Component({
  selector: 'app-site-footer',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './site-footer.component.html',
  styleUrl: './site-footer.component.scss',
})
export class SiteFooterComponent {
  protected readonly siteName = inject(ConfigService).get('site').name;
  protected readonly year = new Date().getFullYear();
}
