import { html } from "htm/preact";

console.log('app.js, imported html', html);

export function app() {
  console.log('app() called');
  return html`<html>
    <body>
      app, <em>in html!</em>
    </body>
  </html>`;
}
