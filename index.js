import render from 'preact-render-to-string'
import { h } from 'preact'
import { Router } from 'itty-router'
import { getAssetFromKV } from '@cloudflare/kv-asset-handler'

import { App } from './src/app.js'
import { html } from './src/html.js'
import { collection } from './src/experiment-with-context.js'

const graphQLOrigin = 'https://staging.stellartickets.com'
collection.origin = graphQLOrigin

const apiAccessToken = STELLAR_STAGING_TOKEN

const router = Router()

const doc = ({ children, appProps }) => {
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
              "preact/hooks": "https://cdn.jsdelivr.net/npm/preact@10.5.14/hooks/dist/hooks.module.js",
              "regexparam": "https://cdn.skypack.dev/pin/regexparam@v2.0.0-UMBtkTmrdIiu5OtJ4Z06/mode=imports/optimized/regexparam.js"
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
          collection.hydrate(props.collection);
          console.log("restored collection", JSON.stringify(collection));
          props.collection = collection;
          console.log("Bootstrapped App with props:", ${JSON.stringify(
            appProps,
          )});
          hydrate(h(App, props), document.getElementById("app"), { pretty: false });
        </script>
      </head>
      <body>
        <div id="app">
          ${children}
        </div>
      </body>
    </html>
  `
}

const renderServerTiming = measurements => {
  const measurementDescriptions = {
    db: 'Querying GraphQL',
    html: 'Rendering Template',
  }
  const durationByName = measurements.reduce((byName, measurement) => {
    const { name, duration } = measurement
    if (!(name in byName)) {
      byName[name] = duration
    } else {
      byName[name] += duration
    }
    return byName
  }, {})
  const renderedHeader = Object.entries(durationByName)
    .map(([name, duration]) => {
      const description = measurementDescriptions[name]
      return `${name};dur=${duration};desc="${description}"`
    })
    .join(', ')
  return renderedHeader
}

const routes = [
  '/',
  '/pages/:page'
];


const renderAndRespond = async ({ params = {} }) => {
  const appProps = { params, collection, routes }
  const measurements = []

  const measure = async (name, cb) => {
    const start = Date.now()
    const value = await cb()
    const end = Date.now()
    const duration = end - start
    measurements.push({ name, duration })
    return value
  }

  let renderCount = 0
  let renderedApp = ''

  const doRender = () => {
    renderCount += 1
    console.log('\n'.repeat(4))
    console.log('RENDER', renderCount, 'started')
    renderedApp = render(h(App, appProps), {}, { pretty: false })
    console.log('RENDER', renderCount, 'completed')
  }

  measure('html', doRender)

  while (collection.pending.size > 0) {
    await measure('db', async () => {
      return await collection.process({
        headers: {
          Authorization: `Bearer ${apiAccessToken}`,
        },
      })
    })
    measure('html', doRender)
  }

  console.log(`render completed in ${renderCount} passes.`)

  const body = await measure('html', () =>
    doc({
      appProps,
      children: renderedApp,
    }),
  )

  collection.reset()

  return new Response(body, {
    headers: {
      'content-type': 'text/html',
      'Server-Timing': renderServerTiming(measurements),
    },
  })
}

routes.forEach(route => router.get(route, renderAndRespond));

//router.get('/', renderAndRespond)
//router.get('/pages/:page', renderAndRespond)
router.post('/graphql', async originalRequest => {
  const body = await originalRequest.json()

  const url = graphQLOrigin + '/graphql'
  const response = await fetch(url, {
    method: 'post',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiAccessToken}`,
    },
    body: JSON.stringify(body),
  })
  console.log('proxied request headers', response.headers)
  const resultJson = await response.json()

  return new Response(JSON.stringify(resultJson), {
    headers: {
      ...response.headers,
      'content-type': 'application/json',
    },
  })
})

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
