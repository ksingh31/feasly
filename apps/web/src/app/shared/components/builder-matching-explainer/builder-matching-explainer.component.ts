import { Component, inject } from '@angular/core';
import { ConfigService } from '../../../core/config/config.service';

/**
 * BuilderMatchingExplainer — one honest definition of "builders associated
 * with us" / "matched builder", shared by the gate, the report next-steps,
 * and (via FAQ copy) the FAQ page. Native <details> disclosure: no JS,
 * keyboard- and screen-reader-friendly. Copy is config-owned
 * (`copy.builderMatching`) so every surface renders the same definition.
 */
@Component({
  selector: 'app-builder-matching-explainer',
  standalone: true,
  templateUrl: './builder-matching-explainer.component.html',
  styleUrl: './builder-matching-explainer.component.scss',
})
export class BuilderMatchingExplainerComponent {
  /** Builder-matching explainer copy (config-owned, buyer-grade). */
  protected readonly copy = inject(ConfigService).get('copy').builderMatching;
}
