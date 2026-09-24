import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** Root shell: the router owns every pixel. Pages bring their own chrome. */
@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  template: '<router-outlet />',
})
export class App {}
