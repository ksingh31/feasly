import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConnectivityService } from './core/errors/connectivity.service';
import { OfflinePageComponent } from './features/error/offline-page.component';
import { ConsentBannerComponent } from './features/consent';

/**
 * Root shell: the router owns every pixel — unless the API is unreachable,
 * in which case the branded offline page takes over (HRD-02). The shell
 * swaps back to the router outlet the moment the health probe succeeds.
 * The consent banner overlays whichever route is active until acknowledged.
 */
@Component({
  imports: [RouterOutlet, OfflinePageComponent, ConsentBannerComponent],
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  protected readonly connectivity = inject(ConnectivityService);
}
