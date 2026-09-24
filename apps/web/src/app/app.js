import { __decorate } from "tslib";
import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
/** Root shell: the router owns every pixel. Pages bring their own chrome. */
let App = class App {
};
App = __decorate([
    Component({
        imports: [RouterOutlet],
        selector: 'app-root',
        template: '<router-outlet />',
    })
], App);
export { App };
