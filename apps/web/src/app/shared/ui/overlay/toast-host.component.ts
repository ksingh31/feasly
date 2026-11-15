import { ChangeDetectionStrategy, Component, ViewEncapsulation, inject, input } from '@angular/core';
import { UiToastService } from './toast.service';

/**
 * Renders the toast stack inside the CDK overlay pane. Created and disposed
 * by {@link UiToastService}; never placed in a template.
 */
@Component({
  selector: 'ui-toast-host',
  standalone: true,
  templateUrl: './toast-host.component.html',
  styleUrl: './toast-host.component.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiToastHostComponent {
  protected readonly service = inject(UiToastService);
  readonly dismissLabel = input('Dismiss');
}
