import render from 'preact-render-to-string'
import { h } from 'preact'
import { Router } from 'itty-router'
import { getAssetFromKV } from '@cloudflare/kv-asset-handler'

import { App } from './src/app.js'
import { html } from './src/html.js'
import { collection } from './src/experiment-with-context.js'

const router = Router()

const doc = ({ children, appProps, renderMeasurements }) => {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>SSR Preact on Cloudflare Workers</title>
        <meta name="robots" content="noindex" />
        <link rel="icon" type="image/png" href="/favicon.png" />
        <script async src="https://cdn.jsdelivr.net/npm/es-module-shims@0.12.2/dist/es-module-shims.min.js"></script>
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
          import { h, hydrate } from "preact";
          import "htm"; // preload
          import "preact/hooks"; // preload
          import "/src/html.js"; // preload

          import { App } from "/src/app.js";
          import { collection } from "/src/experiment-with-context.js";

          const props = ${JSON.stringify(appProps)};
          console.log("Bootstrapped App with props:", props);
          console.log("restoring collection");
          collection.restore(props.collection);
          props.collection = collection;
          hydrate(h(App, props), document.getElementById("app"));
        </script>
      </head>
      <body>
        <div id="app">
          ${children}
        </div>
        <script type="module">
          const renderMeasurements = JSON.parse("${JSON.stringify(renderMeasurements)}")
          console.log("renderMeasurements", renderMeasurements);
        </script>
      </body>
    </html>
  `
}

const renderAndRespond = async ({ params = {} }) => {
  const appProps = { params, collection }
  const renderMeasurements = [];

  let renderCount = 0
  let renderedApp = ''

  const doRender = () => {
    const start = Date.now();
    renderCount += 1
    console.log('\n'.repeat(4))
    console.log('RENDER', renderCount, 'started')
    renderedApp = render(h(App, appProps), {}, { pretty: true })
    console.log('RENDER', renderCount, 'completed')
    const end = Date.now();
    renderMeasurements.push(end - start);
  }
  doRender()

  while (collection.pending.size > 0) {
    await collection.process()
    doRender()
  }

  console.log(`render completed in ${renderCount} passes.`)

  const body = doc({
    appProps,
    children: renderedApp,
    renderMeasurements
  })
  return new Response(body, {
    headers: { 'content-type': 'text/html' },
  })
}

router.get('/', renderAndRespond)
router.get('/pages/:page', renderAndRespond)

// 404 for everything else
router.all('*', () => {
  throw 'no route'
  //console.log('fallback 404 in router hit');
  //return new Response('Not Found.', { status: 404 })
})

addEventListener('fetch', event => {
  console.log('\n\nevent.request.url =>', event.request.url)
  event.respondWith(
    (async () => {
      try {
        const routedResponse = await router.handle(event.request)
        console.log('routedResponse', routedResponse)
        return routedResponse
      } catch (e) {
        if (e === 'no route') {
          try {
            const asset = await getAssetFromKV(event)
            console.log('asset', asset)
            return asset
          } catch (e) {
            console.log('no asset.')
          }
        }
        console.log('404, for reals. e:', e)
        return new Response(
          `Not Found.
        \n\n
        ${e}
        `,
          { status: 404 },
        )
      }
    })(),
  )
})
