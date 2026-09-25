import { Component, input, output } from '@angular/core';

/**
 * Square-footage slider (shared): labeled range input with a live value
 * readout and min/max scale. Used by the new-build scope step and the
 * neighbourhood comparison picker (NBH-04) — built once, reused (DRY).
 *
 * All bounds/labels arrive as inputs (config-owned at the call site); the
 * component clamps to [min, max] and emits whole numbers only.
 */
let nextControlId = 0;

@Component({
  selector: 'app-sqft-slider',
  standalone: true,
  templateUrl: './sqft-slider.component.html',
  styleUrl: './sqft-slider.component.scss',
})
export class SqftSliderComponent {
  /** Current value in sq ft. */
  readonly value = input.required<number>();
  /** Minimum selectable sq ft. */
  readonly min = input.required<number>();
  /** Maximum selectable sq ft. */
  readonly max = input.required<number>();
  /** Slider step in sq ft. */
  readonly step = input.required<number>();
  /** Section heading (e.g. "Living area"). */
  readonly label = input.required<string>();
  /** Helper copy under the heading. */
  readonly hint = input<string>('');
  /** Unit suffix on the value readout (e.g. "sq ft"). */
  readonly unit = input.required<string>();

  /** Emits the clamped whole-number value on every input event. */
  readonly valueChange = output<number>();

  /** Stable id prefix for label association (unique per instance). */
  readonly controlId = `sqft-${++nextControlId}`;

  onInput(event: Event): void {
    const raw = (event.target as HTMLInputElement).valueAsNumber;
    if (!Number.isFinite(raw)) {
      return;
    }
    const clamped = Math.min(this.max(), Math.max(this.min(), Math.round(raw)));
    this.valueChange.emit(clamped);
  }

  protected format(value: number): string {
    return value.toLocaleString('en-CA');
  }
}
