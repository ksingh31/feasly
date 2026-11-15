import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';

/**
 * Saves a JSON payload as a file download (#706). Browser-only: it is called
 * from a click handler, never during SSR/prerender.
 */
@Injectable({ providedIn: 'root' })
export class PrivacyFileService {
  private readonly document = inject(DOCUMENT);

  saveJson(fileName: string, payload: unknown): void {
    const view = this.document.defaultView;
    if (!view?.URL?.createObjectURL) {
      return;
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = view.URL.createObjectURL(blob);
    const anchor = this.document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    this.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    view.URL.revokeObjectURL(url);
  }
}
