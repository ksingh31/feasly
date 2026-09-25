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
  templateUrl: './admin-leads.component.html',
})
export class AdminLeadsComponent {}
