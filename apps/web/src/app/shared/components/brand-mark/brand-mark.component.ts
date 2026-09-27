import { Component, input } from '@angular/core';

/**
 * BrandMark — the Feasly logo mark (four rounded squares). Shared by the
 * public site nav and the admin shell so both headers carry the same logo.
 * Size is configurable; the mark renders on the accent background.
 */
@Component({
  selector: 'app-brand-mark',
  standalone: true,
  templateUrl: './brand-mark.component.html',
  styleUrl: './brand-mark.component.scss',
})
export class BrandMarkComponent {
  /** Mark box size in px (default 32, matches the site nav). */
  readonly size = input<number>(32);
}
