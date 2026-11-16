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
  private readonly config = inject(ConfigService);
  protected readonly siteName = this.config.get('site').name;
  /** #704: "Find my report" entry for returning users on any device. */
  // Optional chaining: page specs stub ConfigService with partial copy.
  protected readonly findReportLabel = this.config.get('copy')?.returning?.findReportLink ?? '';
  /** #831: public Upptime status page; empty = no link (never a dead end). */
  protected readonly statusPageUrl = this.config.get('site').statusPageUrl ?? '';
  protected readonly year = new Date().getFullYear();
}
