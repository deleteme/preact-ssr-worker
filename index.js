import render from 'preact-render-to-string';
import { Router } from 'itty-router'
import { getAssetFromKV } from "@cloudflare/kv-asset-handler"

import { App } from "./src/app.js";
import { html } from "./src/html.js";

const router = Router()

const doc = ({ children, params = {} }) => {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>SSR Preact on Cloudflare Workers</title>
        <link rel="icon" type="image/png" href="/favicon.png" />
        <script async src="https://unpkg.com/es-module-shims@0.12.2/dist/es-module-shims.js"></script>
        <script type="importmap">
          {
            "imports": {
              "htm": "https://cdn.jsdelivr.net/npm/htm@3.1.0/dist/htm.module.js",
              "preact": "https://cdn.jsdelivr.net/npm/preact@10.5.14/dist/preact.module.js",
              "preact/hooks": "https://cdn.jsdelivr.net/npm/preact@10.5.14/hooks/dist/hooks.module.js"
            }
          }
        </script>
        <script type="module">
          import { h, hydrate } from 'preact';
          import "htm"; // preload
          import "preact/hooks"; // preload
          import "/src/html.js"; // preload

          import { App } from "/src/app.js";
          const props = { params: JSON.parse('${(JSON.stringify(params))}') };
          hydrate(h(App, props), document.getElementById('app'));
        </script>
      </head>
      <body>
        ${children}
      </body>
    </html>
  `
};

const renderAndRespond = ({params = {}}) => {
  let content = doc({ params, children: render(
    html`
      <div id="app">
        <${App} params=${params} />
      </div>
    `
  ) });
  return new Response(content, {
    headers: { 'content-type': 'text/html' },
  })
};

router.get("/", renderAndRespond);
router.get("/pages/:page", renderAndRespond);
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
  throw 'no route';
  //console.log('fallback 404 in router hit');
  //return new Response('Not Found.', { status: 404 })
});


addEventListener('fetch', event => {
  //event.respondWith(router.handle(event.request))
  console.log('\n\nevent.request.url =>', event.request.url);
  event.respondWith((async () => {
    try {
      const routedResponse = await router.handle(event.request);
      console.log('routedResponse', routedResponse);
      return routedResponse;
    } catch (e) {
      if (e === 'no route') {
        try {
          const asset = await getAssetFromKV(event)
          console.log('asset', asset);
          return asset;
        } catch (e) {
          console.log('no asset.');
        }
      }
      console.log('404, for reals. e:', e);
      return new Response(`Not Found.
        \n\n
        ${e}
        `, { status: 404 })
    }
  })())
})



