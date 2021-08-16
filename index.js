import render from 'preact-render-to-string';
import { html } from 'htm/preact';
import { Router } from 'itty-router'
import { getAssetFromKV } from "@cloudflare/kv-asset-handler"

import { App } from "./src/app.js";

const router = Router()

const Document = ({ children }) => html`
  <html>
    <head>
      <title>SSR Preact on Cloudflare Workers</title>
      <link rel="icon" type="image/png" href="/favicon.png" />
    </head>
    <body>
      ${children}
      <script src="/src/app.js" type="module"></script>
    </body>
  </html>
`;

const renderAndRespond = ({params}) => {
  let content = `<!DOCTYPE html>\n`;
  content += render(
    html`<${Document}>
      <div id="app">
        <${App} params=${params} />
      </div>
    <//>`
  );
  return new Response(content, {
    headers: { 'content-type': 'text/html' },
  })
};

router.get("/", renderAndRespond);
router.get("/about", renderAndRespond);
//router.get("/src/*", async function handleReq(request) {
  //console.log('handleEvent called with requset',request);
  //try {
    //return await getAssetFromKV(event)
  //} catch (e) {
    //console.log('caught error:', e);
    //let pathname = new URL(request.url).pathname
    //return new Response(`"${pathname}" not found`, {
      //status: 404,
      //statusText: "not found",
    //})
  //}
//});


// 404 for everything else
router.all('*', () => {
  console.log('fallback 404 in router hit');
  return new Response('Not Found.', { status: 404 })
});


addEventListener('fetch', event => {
  //event.respondWith(router.handle(event.request))
  event.respondWith((async () => {
    try {
      const asset = await getAssetFromKV(event)
      console.log('asset', asset);
      return asset;
    } catch (e) {
      console.log('caught error, sending to router', e);
      return router.handle(event.request);
    }
  })())
})



