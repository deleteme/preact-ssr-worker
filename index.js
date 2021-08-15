import render from 'preact-render-to-string';
import { html } from 'htm/preact';
import { Router } from 'itty-router'
import { App } from "./app.js";

const router = Router()

const Document = ({ children }) => html`
  <html>
    <head>
      <title>SSR Preact on Cloudflare Workers</title>
    </head>
    <body>
      ${children}
    </body>
  </html>
`;

const renderAndRespond = ({params}) => {
  let content = `<!DOCTYPE html>\n`;
  content += render(
    html`<${Document}><${App} params=${params} /><//>`
  );
  return new Response(content, {
    headers: { 'content-type': 'text/html' },
  })
};

router.get("/", renderAndRespond);
router.get("/:page", renderAndRespond);


// 404 for everything else
router.all('*', () => new Response('Not Found.', { status: 404 }))

addEventListener('fetch', event => {
  event.respondWith(router.handle(event.request))
})
