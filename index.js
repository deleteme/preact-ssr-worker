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
        <meta name="viewport" content="width=device-width" />
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
    kv: 'Reading KV cache',
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

const routes = ['/', '/pages/:page']

const getSecondsSinceEpoch = secondsFromNow => {
  const now = Date.now() / 60
  return Math.round(Math.abs(now + secondsFromNow))
}

const renderAndRespond = async request => {
  const { params = {}, url } = request
  const cacheUrl = new URL(request.url)
  const cacheKey = cacheUrl.pathname
  const measurements = []

  const measure = async (name, cb) => {
    const start = Date.now()
    const value = await cb()
    const end = Date.now()
    const duration = end - start
    measurements.push({ name, duration })
    return value
  }
  const ttl = 60
  const cachedBody = await measure('kv', async () => {
    return await HTMLBODY.get(cacheKey, { cacheTtl: ttl })
  })
  console.log(
    `cacheKey: '${cacheKey}',`,
    'cachedBody && cachedBody.length',
    cachedBody && cachedBody.length,
  )
  const getHeaders = () => {
    return {
      'content-type': 'text/html',
      'Server-Timing': renderServerTiming(measurements),
      'Cache-Control': `public`,
      //Expires: (d => {
      //d.setSeconds(d.getSeconds() + ttl);
      //return d.toGMTString()
      //})(new Date())
    }
  }
  let response

  if (cachedBody) {
    console.log('CACHE HIT: reusing body from kv HTMLBODY namespace')
    response = new Response(cachedBody, {
      headers: getHeaders(),
    })
  } else {
    console.log('CACHE MISS: kv HTMLBODY namespace')
    const routerInitialState = { params, url }
    const appProps = { params, collection, routes, routerInitialState }

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

    console.log('writing body to kv HTMLBODY namespace')
    await HTMLBODY.put(cacheKey, body, {
      expirationTtl: ttl,
    })

    collection.reset()

    response = new Response(body, {
      headers: getHeaders(),
    })
  }
  return response
}

routes.forEach(route => router.get(route, renderAndRespond))

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
  console.log('proxied response headers', JSON.stringify(response.headers))
  const resultJson = await response.json()

  const allowedCorsOrigins = ['http://localhost:63019']
  console.log(
    'originalRequest.headers',
    JSON.stringify(originalRequest.headers),
  )
  console.log('originalRequest.headers.origin', originalRequest.headers.origin)
  const corsOrigin = allowedCorsOrigins.find(
    o => o === originalRequest.headers.get('Origin'),
  )
  console.log('corsOrigin:', corsOrigin)

  const corsHeaders = {}
  if (corsOrigin) {
    corsHeaders['Access-Control-Allow-Origin'] = corsOrigin
    corsHeaders['Vary'] = 'Origin'
  }
  console.log('corsHeaders:', JSON.stringify(corsHeaders))
  return new Response(JSON.stringify(resultJson), {
    headers: {
      ...response.headers,
      'content-type': 'application/json',
      ...corsHeaders,
    },
  })
})
router.post('/add-to-cart', async originalRequest => {
  const formData = await originalRequest.formData();
  const body = JSON.stringify(Object.fromEntries(formData.entries()))
  return new Response(body, {
    headers: {
      'content-type': 'text/html',
    }
  });
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
        console.log(
          'JSON.stringify(event.request.headers.entries())',
          ...event.request.headers.entries(),
        )
        console.log(
          'event.request.headers.get("Origin")',
          event.request.headers.get('Origin'),
        )
        const routedResponse = await router.handle(event.request)
        console.log('routedResponse', routedResponse)
        console.log(
          'routedResponse.headers',
          JSON.stringify(routedResponse.headers),
        )
        return routedResponse
      } catch (e) {
        if (e === 'no route') {
          try {
            const asset = await getAssetFromKV(event, {
              cacheControl: {
                browserTTL: 60 * 60 * 24
              }
            })
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
