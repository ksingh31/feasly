import { Component } from '@angular/core';

/**
 * Admin leads placeholder (admin/01).
 *
 * The full leads dashboard lands in a later story (admin/02+). This
 * placeholder proves the guarded route group works: successful magic-link
 * verification lands here per the story.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-admin-leads',
  standalone: true,
  template: `
    <h1>Leads</h1>
    <p>The leads dashboard is coming in a follow-up story.</p>
  `,
})
export class AdminLeadsComponent {}
