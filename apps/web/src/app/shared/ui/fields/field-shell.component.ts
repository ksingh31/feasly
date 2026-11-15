import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Field chrome shared by every UI-kit field: label above the projected
 * control, hint below, error (replacing the hint) in `--status-danger-fg`.
 * Presentational only; ids come from `UiFieldBase`.
 */
@Component({
  selector: 'ui-field-shell',
  standalone: true,
  templateUrl: './field-shell.component.html',
  styleUrl: './field-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiFieldShellComponent {
  readonly label = input.required<string>();
  readonly controlId = input.required<string>();
  readonly hintId = input.required<string>();
  readonly errorId = input.required<string>();
  readonly hint = input<string | null>(null);
  readonly error = input<string | null>(null);
  readonly required = input(false);
}
