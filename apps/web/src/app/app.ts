import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConnectivityService } from './core/errors/connectivity.service';
import { OfflinePageComponent } from './features/error/offline-page.component';

/**
 * Root shell: the router owns every pixel — unless the API is unreachable,
 * in which case the branded offline page takes over (HRD-02). The shell
 * swaps back to the router outlet the moment the health probe succeeds.
 */
@Component({
  imports: [RouterOutlet, OfflinePageComponent],
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  protected readonly connectivity = inject(ConnectivityService);
}
