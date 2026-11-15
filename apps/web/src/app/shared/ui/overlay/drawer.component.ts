import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  booleanAttribute,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { UiDrawerRef } from './drawer.service';

/**
 * Drawer shell (`ui-drawer`) — portal-ui-kit §3. The chrome for content
 * opened with {@link UiDrawerService}: sticky header (title, chip + meta,
 * close ×), scrolling body, sticky footer (secondary left, primary right).
 * Right side on desktop (`sm`/`md`/`lg`); a full-height sheet below 768px.
 *
 * ```html
 * <ui-drawer heading="Marco Silva" asForm [dirty]="form.dirty" (submitted)="save()">
 *   <ui-status-chip uiDrawerChip tone="info">Contacted</ui-status-chip>
 *   <span uiDrawerMeta>Created Nov 12, 2026</span>
 *   …fields…
 *   <button uiDrawerFooterStart type="button" ui-button variant="secondary" (click)="ref.requestClose()">Cancel</button>
 *   <button uiDrawerFooterEnd type="submit" ui-button>Save</button>
 * </ui-drawer>
 * ```
 *
 * `dirty` arms the guard: Esc, scrim, × and Back ask before discarding.
 * Styles are unencapsulated (`ui-drawer*` prefixed) because the CDK pane
 * and scrim live outside any component's view.
 */
@Component({
  selector: 'ui-drawer',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './drawer.component.html',
  styleUrl: './drawer.component.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ui-drawer' },
})
export class UiDrawerComponent {
  readonly heading = input.required<string>();
  /** Unsaved changes: closing asks first. */
  readonly dirty = input(false, { transform: booleanAttribute });
  /** Show the × button. */
  readonly closable = input(true, { transform: booleanAttribute });
  /** Wrap body + footer in a form; Enter emits `submitted`. */
  readonly asForm = input(false, { transform: booleanAttribute });
  readonly closeLabel = input('Close');

  /** The form was submitted (asForm only). */
  readonly submitted = output<void>();

  private readonly ref = inject(UiDrawerRef, { optional: true });
  protected readonly titleId = this.ref?.titleId ?? null;

  constructor() {
    effect(() => this.ref?.setDirty(this.dirty()));
  }

  /** Guarded close (asks first when dirty). */
  close(): void {
    this.ref?.requestClose();
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    this.submitted.emit();
  }
}
