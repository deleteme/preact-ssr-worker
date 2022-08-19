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
            //Authorization: `Bearer ${apiAccessToken}`,
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
      //Authorization: `Bearer ${apiAccessToken}`,
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

router.get('/test-twitter-card--2', () => {
  const body = `
<!DOCTYPE html>
<html class="hydrated">
<head>
    <base href="https://timucua.stellartickets.com">
    <style data-styles="">
    ion-icon {
        visibility:hidden
    }

    .hydrated {
        visibility: inherit
    }
    </style>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="facebook-domain-verification" content="4twcqc3rnl0q8n4y5wgz7xspn7is6a">
    <link rel="icon" href="/favicon.ico" sizes="any">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <style>
    html {
        transition: background-color .25s;
    }
    </style>
    <link id="organizations_stylesheet" rel="stylesheet" href="https://assets.stellartickets.com/dist/organizations-root-91e2fa5c9b213b36a5289c465d04b07f02802cc4.css" media="all" crossorigin="anonymous">
    <link id="organizations_dark_stylesheet" rel="stylesheet" href="https://assets.stellartickets.com/dist/organizations-root-dark-91e2fa5c9b213b36a5289c465d04b07f02802cc4.css" media="all" crossorigin="anonymous">
    <link id="consumer_stylesheet" rel="stylesheet" href="https://assets.stellartickets.com/dist/root-91e2fa5c9b213b36a5289c465d04b07f02802cc4.css" media="all" crossorigin="anonymous">

    <style data-emotion="css" data-s=""></style>
    <style data-emotion="css" data-s="">
    .css-h56ruz {
        position: fixed;
        bottom: 1em;
        right: 1em;
        z-index: 41;
        max-width: 550px;
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
        -webkit-flex-direction: column;
        -ms-flex-direction: column;
        flex-direction: column;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 769px) {
        .css-h56ruz {
            max-width: 100%;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-h56ruz > div {
        margin-bottom: 0.5rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-uudtwc.navbar {
        padding-top: 4px;
        padding-bottom: 3px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-uudtwc .navbar-item-org-logo {
        padding-top: 0;
        padding-bottom: 0;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-uudtwc .org-logo, .css-uudtwc .org-logo-placeholder {
        border: 0;
        color: transparent;
        height: var(--org-logo-size);
        max-height: var(--org-logo-size);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .stellar-logo {
        color: transparent;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .sell-button, .css-3fr1qq .navbar-item {
        font-weight: 500;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media (max-width: 1024px) {
        .css-3fr1qq {
            padding-left: 1.5rem;
            padding-right: 1.5rem;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media (max-width: 414px) {
        .css-3fr1qq {
            padding-left: 1rem;
            padding-right: 1rem;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 769px) {
        .css-3fr1qq .active-bar {
            display: none;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .navbar-brand {
        margin-left: -0.75rem;
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq.navbar {
        border-bottom: var(--stellar-border);
        padding-top: 8px;
        padding-bottom: 7px;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (min-width: 770px) {
        .css-3fr1qq .navbar-start, .css-3fr1qq .navbar-end {
            -webkit-align-items: center;
            -webkit-box-align: center;
            -ms-flex-align: center;
            align-items: center;
        }

        .css-3fr1qq .navbar-start > .navbar-item:not(.has-dropdown), .css-3fr1qq .navbar-end > .navbar-item:not(.has-dropdown), .css-3fr1qq .navbar-start > .button, .css-3fr1qq .navbar-end > .button {
            margin-left: 1rem;
        }

        .css-3fr1qq .navbar-start > .navbar-item.has-dropdown .navbar-link, .css-3fr1qq .navbar-end > .navbar-item.has-dropdown .navbar-link {
            padding-left: 1rem;
            margin-left: 1rem;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .logged-user-wrapper .logged-user-title {
        font-size: 12px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .logged-user-wrapper .logged-user-email {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 200px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .nested-navbar-item-with-icon {
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .nested-navbar-item-with-icon ion-icon {
        font-size: 20px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .navbar-item-with-icon {
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .navbar-item-with-icon .icon {
        width: 20px;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (min-width: 770px) {
        .css-3fr1qq .navbar-item-with-icon .icon {
            width: 24px;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .navbar-item-with-icon ion-icon {
        font-size: 20px;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (min-width: 770px) {
        .css-3fr1qq .navbar-item-with-icon ion-icon {
            font-size: 24px;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .active-bar {
        --active-bar-width: 32%;
        background-color: var(--fuchsia);
        opacity: 0;
        height: 3px;
        width: var(--active-bar-width);
        position: absolute;
        bottom: 0;
        left: 50%;
        margin-left: calc(var(--active-bar-width) / -2);
        border-radius: 3px;
        -webkit-transition: opacity 0.1s ease-out;
        transition: opacity 0.1s ease-out;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .active .active-bar {
        opacity: 1;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .search ion-icon {
        font-size: 22px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .search span {
        display: none;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (min-width: 770px) {
        .css-3fr1qq .navbar-dropdown {
            background: var(--box-background-color);
            box-shadow: var(--box-shadow);
            border-radius: var(--radius-large);
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 769px) {
        .css-3fr1qq .navbar-item.has-dropdown .account-menu-control {
            display: none;
        }

        .css-3fr1qq .navbar-dropdown {
            padding-bottom: 0;
        }

        .css-3fr1qq .navbar-dropdown .navbar-item {
            font-size: 1rem;
            padding-left: 0.75rem;
        }

        .css-3fr1qq .search {
            display: -webkit-box;
            display: -webkit-flex;
            display: -ms-flexbox;
            display: flex;
        }

        .css-3fr1qq .search ion-icon {
            margin-right: 0.5rem;
        }

        .css-3fr1qq .search span {
            display: block;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq.navbar {
        padding-top: 4px;
        padding-bottom: 3px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .navbar-item-org-logo {
        padding-top: 0;
        padding-bottom: 0;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-3fr1qq .org-logo, .css-3fr1qq .org-logo-placeholder {
        border: 0;
        color: transparent;
        height: var(--org-logo-size);
        max-height: var(--org-logo-size);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-18ccy2v .title {
        font-size: 1.25rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-18ccy2v .subtitle {
        font-size: 14px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa {
        display: block;
        padding: 0;
        box-shadow: none;
        --card-border-radius: var(--radius-large);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa .card-image .image {
        overflow: hidden;
        position: relative;
        z-index: 1;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa .card-image .image img {
        -webkit-transition: -webkit-transform 400ms ease-out;
        transition: transform 400ms ease-out;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa:hover .card-image .image img, .css-14xpkpa:focus .card-image .image img {
        -webkit-transform: scale(1.025);
        -moz-transform: scale(1.025);
        -ms-transform: scale(1.025);
        transform: scale(1.025);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa:active .card-image .image img {
        -webkit-transform: scale(1);
        -moz-transform: scale(1);
        -ms-transform: scale(1);
        transform: scale(1);
        transition-duration: 0.1ms;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa.card-box {
        background-color: var(--box-background-color);
        border-radius: var(--card-border-radius);
        box-shadow: var(--box-shadow);
        overflow: hidden;
        position: relative;
        z-index: 1;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa.card-box:hover {
        box-shadow: var(--box-link-hover-shadow);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa.card-box:active {
        box-shadow: var(--box-link-active-shadow);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa.card-box .title {
        font-size: 1.5rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa:hover {
        color: white;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa:not(.card-box) .card-content {
        padding-left: 0;
        padding-right: 0;
        padding-top: 10px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa:not(.card-box) .card-image .image {
        border-radius: var(--card-border-radius);
        overflow: hidden;
        box-shadow: var(--box-shadow);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa:not(.card-box):active .card-image .image {
        box-shadow: none;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa:not(.card-box) .title {
        font-size: 1.25rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa:not(.card-box) .subtitle {
        font-size: 14px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-14xpkpa .subtitle {
        font-size: 1rem;
        font-weight: 500;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1oein7u {
        display: grid;
        --grid-column-gap: 24px;
        --min-column-width: calc((100% / var(--grid-columns-count, 2)) - var(--grid-column-gap)
        );
        grid-template-columns: repeat( var(--grid-columns-count, 2), minmax(var(--min-column-width), 1fr)
        );
        -webkit-column-gap: var(--grid-column-gap);
        column-gap: var(--grid-column-gap);
        row-gap: 24px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1xqe447 {
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
        -webkit-flex-direction: row;
        -ms-flex-direction: row;
        flex-direction: row;
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
        margin-top: 1.5rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1xqe447 .organization-image {
        margin-right: 0.5rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1xqe447 .organization-name {
        font-size: 14px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 350px;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 769px) {
        .css-1xqe447 .organization-name {
            max-width: 200px;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1xqe447.is-small .organization-name {
        max-width: 150px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-su7zci.social-icons {
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
        width: 100%;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 769px) {
        .css-su7zci.social-icons {
            -webkit-box-pack: start;
            -ms-flex-pack: start;
            -webkit-justify-content: flex-start;
            justify-content: flex-start;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-su7zci.social-icons .social-icon {
        font-size: 20px;
        border-radius: 50%;
        background: var(--org-social-icon-background-color, var(--primary));
        color: var(--org-social-icon-foreground-color, var(--primary-invert));
        height: 32px;
        width: 32px;
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
        -webkit-box-pack: center;
        -ms-flex-pack: center;
        -webkit-justify-content: center;
        justify-content: center;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-su7zci.social-icons .social-icon:not(:last-child) {
        margin-right: 1.2rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-ru4gp7 .merch-product-image {
        border-radius: 4px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-ru4gp7 .merch-no-image-placeholder {
        border: var(--stellar-border);
        border-radius: 4px;
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
        -webkit-box-pack: center;
        -ms-flex-pack: center;
        -webkit-justify-content: center;
        justify-content: center;
        font-size: 14px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-ru4gp7 .merch-name {
        font-weight: bold;
        font-size: 24px;
        margin-bottom: 20px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-ru4gp7 .merch-product-image-container {
        float: left;
        margin-right: 20px;
        margin-bottom: 20px;
        -webkit-flex-shrink: 0;
        -ms-flex-negative: 0;
        flex-shrink: 0;
        position: relative;
        z-index: 1;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-ru4gp7 .content ul {
        list-style: disc inside;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1ce57di {
        --org-home-h-padding: 20px;
        --org-home-inset-max-width: 100%;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (min-width: 1000px) {
        .css-1ce57di {
            --org-home-inset-max-width: 1000px;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (min-width: 1440px) {
        .css-1ce57di {
            --lower-limit: 1000px;
            --upper-limit: 1400px;
            --min-diff: calc(100% - var(--lower-limit));
            --max-diff: calc(100% - var(--upper-limit));
            --org-home-inset-width: calc(100% - var(--min-diff) + var(--max-diff));
            --org-home-inset-max-width: var(--upper-limit);
            --grid-columns-count: 3;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 600px) {
        .css-1ce57di {
            --grid-columns-count: 1;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1ce57di .inset {
        padding-left: var(--org-home-h-padding);
        padding-right: var(--org-home-h-padding);
        width: var(--org-home-inset-width);
        max-width: var(--org-home-inset-max-width);
        margin: 0 auto;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1ce57di .inset-section {
        padding-bottom: 2rem;
        padding-top: 2rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 {
        padding-bottom: 2rem;
        position: relative;
        padding-top: 3rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 600px) {
        .css-1mpgwh6 {
            padding-top: 1rem;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .home-hero-content {
        z-index: 1;
        position: relative;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 600px) {
        .css-1mpgwh6 {
            padding-bottom: 1rem;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .page-title {
        line-height: 1em;
        font-weight: bold;
        margin-bottom: 0;
        font-size: 3rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 800px) {
        .css-1mpgwh6 .page-title {
            font-size: 2rem;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .social-row {
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .header-alignment-left {
        -webkit-flex-direction: column;
        -ms-flex-direction: column;
        flex-direction: column;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .header-alignment-left .social-row {
        margin-top: 1rem;
        -webkit-box-pack: start;
        -ms-flex-pack: start;
        -webkit-justify-content: flex-start;
        justify-content: flex-start;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .header-alignment-left .social-row .social-icons {
        width: auto;
        margin-right: 0.75rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .header-alignment-center {
        -webkit-flex-direction: column;
        -ms-flex-direction: column;
        flex-direction: column;
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .header-alignment-center .social-row {
        margin-top: 1rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .header-alignment-center .social-row .social-icons {
        margin-right: 0.75rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .header-alignment-justify {
        -webkit-box-pack: justify;
        -webkit-justify-content: space-between;
        justify-content: space-between;
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .header-alignment-justify .social-row {
        -webkit-flex-direction: row-reverse;
        -ms-flex-direction: row-reverse;
        flex-direction: row-reverse;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .header-alignment-justify .social-row .share-button {
        margin-right: 1rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .desktop-hero-content {
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
        padding: 2rem 0;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .desktop-hero-content .page-title {
        max-width: calc(100% - 300px);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .desktop-hero-content .social-row {
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
        height: 3rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .mobile-hero-content {
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
        padding: 1.5rem 0;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1mpgwh6 .mobile-hero-content .page-title {
        font-size: 1.5rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-nx4pnq {
        margin-bottom: 2rem;
        margin-top: 1rem;
        padding-top: calc(100% *(9 / 16));
        position: relative;
        width: 100%;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 600px) {
        .css-nx4pnq {
            margin-left: calc(-1 * var(--org-home-h-padding));
            margin-right: calc(-1 * var(--org-home-h-padding));
            width: calc(100% +(2 * var(--org-home-h-padding)));
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-nx4pnq .gallery-image {
        left: 0;
        position: absolute;
        top: 0;
        height: 100%;
        width: 100%;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-ady3y5 {
        color: transparent;
        display: block;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1b4c7u6 {
        letter-spacing: 4px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1c053el {
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
        height: 2.25rem;
        margin-top: 0.5rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1c8u29q {
        -webkit-transition: 0.15s opacity ease;
        transition: 0.15s opacity ease;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 999px) {
        .css-1c8u29q .title {
            font-size: 1.25rem;
        }

        .css-1c8u29q .subtitle {
            font-size: 14px;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1ecj14j {
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
        -webkit-flex-direction: row;
        -ms-flex-direction: row;
        flex-direction: row;
        -webkit-box-flex-wrap: nowrap;
        -webkit-flex-wrap: nowrap;
        -ms-flex-wrap: nowrap;
        flex-wrap: nowrap;
        overflow-x: auto;
        scrollbar-width: thin;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1ecj14j .radio + .radio {
        margin-left: 2rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1wsqsr1 {
        -webkit-box-flex-wrap: nowrap;
        -webkit-flex-wrap: nowrap;
        -ms-flex-wrap: nowrap;
        flex-wrap: nowrap;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-nvcufe {
        -webkit-box-flex-wrap: nowrap;
        -webkit-flex-wrap: nowrap;
        -ms-flex-wrap: nowrap;
        flex-wrap: nowrap;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-nvcufe::before {
        display: block;
        content: "";
        margin: 0 2rem;
        width: 1px;
        background-color: var(--stellar-border-color);
        height: 2rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-zviajk {
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
        font-size: 0.875rem;
        position: relative;
        text-align: center;
        white-space: nowrap;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-zdnpxn {
        position: absolute;
        top: 0;
        opacity: 0;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-zdnpxn:checked ~ span {
        color: var(--link-active);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-zdnpxn:checked ~ svg .circle-internal {
        display: block;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-a85dzo {
        margin-right: 0.5rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-a85dzo .circle-border {
        stroke: var(--link-active);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-a85dzo .circle-internal {
        display: none;
        fill: var(--link-active);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-x3ui0p {
        display: grid;
        --grid-column-gap: 24px;
        --min-column-width: calc((100% / var(--grid-columns-count, 2)) - var(--grid-column-gap)
        );
        grid-template-columns: repeat( var(--grid-columns-count, 2), minmax(var(--min-column-width), 1fr)
        );
        -webkit-column-gap: var(--grid-column-gap);
        column-gap: var(--grid-column-gap);
        row-gap: 24px;
        -webkit-transition: 0.15s opacity ease;
        transition: 0.15s opacity ease;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 999px) {
        .css-x3ui0p .title {
            font-size: 1.25rem;
        }

        .css-x3ui0p .subtitle {
            font-size: 14px;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1wm5blw {
        font-size: 0.75rem;
        color: var(--stellar-accent-color);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1wm5blw ion-icon {
        color: var(--stellar-accent-color);
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1wm5blw .control {
        margin-right: 0.4rem !important;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1wm5blw .tag {
        background: transparent;
        padding-left: 0;
        padding-right: 0.25rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (min-width: 871px) {
        .css-6jzyzf {
            --grid-columns-count: 4;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 870px) {
        .css-6jzyzf {
            --grid-columns-count: 3;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 600px) {
        .css-6jzyzf {
            --grid-columns-count: 2;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 380px) {
        .css-6jzyzf {
            --grid-columns-count: 1;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-4mvrle {
        display: grid;
        --grid-column-gap: 24px;
        --min-column-width: calc((100% / var(--grid-columns-count, 2)) - var(--grid-column-gap)
        );
        grid-template-columns: repeat( var(--grid-columns-count, 2), minmax(var(--min-column-width), 1fr)
        );
        -webkit-column-gap: var(--grid-column-gap);
        column-gap: var(--grid-column-gap);
        row-gap: 24px;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (min-width: 871px) {
        .css-4mvrle {
            --grid-columns-count: 4;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 870px) {
        .css-4mvrle {
            --grid-columns-count: 3;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 600px) {
        .css-4mvrle {
            --grid-columns-count: 2;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 380px) {
        .css-4mvrle {
            --grid-columns-count: 1;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1ueoyg1 {
        padding-bottom: 2rem;
        margin-bottom: 2rem;
        margin-top: 2rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1ueoyg1 .title {
        margin-bottom: 0;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1ueoyg1 .about-links-link + .about-links-link {
        margin-top: 1rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1ueoyg1.has-description .about-organization {
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1ueoyg1.has-description .about-content, .css-1ueoyg1.has-description .about-links {
        -webkit-flex-basis: 50%;
        -ms-flex-preferred-size: 50%;
        flex-basis: 50%;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1ueoyg1.has-description .about-content + .about-links {
        margin-left: 2rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1ueoyg1.has-description .about-links-content + .social-icons {
        margin-top: 2rem;
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 600px) {
        .css-1ueoyg1.has-description .about-organization {
            -webkit-flex-direction: column;
            -ms-flex-direction: column;
            flex-direction: column;
        }

        .css-1ueoyg1.has-description .about-content + .about-links {
            margin-left: 0;
            margin-top: 2rem;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (min-width: 600px) {
        .css-1ueoyg1.no-description .about-links {
            -webkit-align-items: flex-start;
            -webkit-box-align: flex-start;
            -ms-flex-align: flex-start;
            align-items: flex-start;
            display: -webkit-box;
            display: -webkit-flex;
            display: -ms-flexbox;
            display: flex;
            -webkit-box-pack: justify;
            -webkit-justify-content: space-between;
            justify-content: space-between;
        }

        .css-1ueoyg1.no-description .social-icons {
            width: auto;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    @media screen and (max-width: 600px) {
        .css-1ueoyg1.no-description .about-links-content + .social-icons {
            margin-top: 2rem;
        }
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-183yca4 {
        background: none;
        border: 0;
        border-bottom: var(--stellar-border);
        margin: 1rem 0;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1gvckja {
        -webkit-align-items: center;
        -webkit-box-align: center;
        -ms-flex-align: center;
        align-items: center;
        display: -webkit-box;
        display: -webkit-flex;
        display: -ms-flexbox;
        display: flex;
        -webkit-box-pack: justify;
        -webkit-justify-content: space-between;
        justify-content: space-between;
        margin-bottom: 20px;
        border-top: var(--stellar-border);
        height: 120px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1gvckja .powered-by-stellar-link {
        color: var(--text);
        font-weight: bold;
        text-align: right;
    }
    </style>
    <style data-emotion="css" data-s="">
    .css-1gvckja .powered-by-stellar-link img {
        margin-top: 2px;
    }
    </style>
    <style data-emotion="css" data-s="">
    .is-light-theme .css-1gvckja .powered-by-stellar-link img {
        -webkit-filter: brightness(0);
        filter: brightness(0);
    }
    </style>
    <title>Timucua Arts Foundation • Stellar Tickets</title>
    <meta property="og:type" content="website" data-react-helmet="true">
    <meta property="twitter:card" content="summary_large_image" data-react-helmet="true">
    <style data-org-theme="true" data-react-helmet="true">
    :root {
        --scheme-main: #000000;
        --text: #ffffff;
        --link: #0488c7;
        --primary: #0488c7;
        --stellar-accent-color: #c4b4f8;
        --scheme-main-rgb: 0, 0, 0;
        --box-background-color: #1a1a1a;
        --box-background-color-rgb: 26, 26, 26;
        --primary-invert: rgb(0, 0, 0);
        --secondary-invert: rgb(0, 0, 0);
        --stellar-border: 1px solid rgba(255, 255, 255, 0.1);
        --link-visited: #0488c7;
        --link-hover: #036695;
        --link-focus: #024463;
        --link-active: #024463;
        --text-faded: #ccc;
        --navbar-item-hover-color: #ccc;
        --input-background-color: #343434;
        --input-disabled-background-color: #272727;
        --input-color: #ffffff;
        --input-placeholder-color: #d9d9d9;
        --input-focus-border-color: #676767;
        --primary-button-hover-background-color: #0377ae;
        --primary-button-focus-border-color: #024463;
        --background-color-darker: #000;
        --secondary: #c4b4f8;
        --stellar-accent-color-invert: rgb(0, 0, 0);
        --modal-background-background-color: rgba(0, 0, 0, 0.5);
        --primary-button-active-background-color: #0499e0;
    }

    .navbar-divider {
        --stellar-border-color: rgba(255, 255, 255, 0.1);
    }

    .box {
        --stellar-border: 1px solid rgba(255, 255, 255, 0.1);
    }
    </style>
    <meta property="og:title" content="Timucua Arts Foundation" data-react-helmet="true">
    <meta property="twitter:title" content="Timucua Arts Foundation" data-react-helmet="true">
    <meta name="title" content="Timucua Arts Foundation" data-react-helmet="true">
    <meta property="og:image" content="https://media.stellarlive.tech/c_fill,q_auto/agrdach02krub8mm7xsc.webp" data-react-helmet="true">
    <meta property="twitter:image" content="https://media.stellarlive.tech/c_fill,q_auto/agrdach02krub8mm7xsc.webp" data-react-helmet="true">
    <meta property="og:description" content="Our mission is to inspire you with engaging experiences of the arts

    Timucua Arts Foundation is a multi-faceted arts and education institution, presenting concerts and festivals, operating the unique and intimate Timucua venue, and delivering education and wellness programming to people of all ages.
    Timucua’s distinctive integration of the performing and visual arts has carved a niche for high-level, accessibly-priced programming in an intimate venue.
    Our values are rooted in community service, " data-react-helmet="true">
    <meta property="twitter:description" content="Our mission is to inspire you with engaging experiences of the arts

    Timucua Arts Foundation is a multi-faceted arts and education institution, presenting concerts and festivals, operating the unique and intimate Timucua venue, and delivering education and wellness programming to people of all ages.
    Timucua’s distinctive integration of the performing and visual arts has carved a niche for high-level, accessibly-priced programming in an intimate venue.
    Our values are rooted in community service, " data-react-helmet="true">
    <meta name="description" content="Our mission is to inspire you with engaging experiences of the arts

    Timucua Arts Foundation is a multi-faceted arts and education institution, presenting concerts and festivals, operating the unique and intimate Timucua venue, and delivering education and wellness programming to people of all ages.
    Timucua’s distinctive integration of the performing and visual arts has carved a niche for high-level, accessibly-priced programming in an intimate venue.
    Our values are rooted in community service, " data-react-helmet="true">
    <base href="https://timucua.stellartickets.com">
</head>
<body class="is-dark-theme" data-react-helmet="class">
    <noscript>
        <section class="section">
            <div class="container">
                <div class="box">
                            Please enable JavaScript to use this page.
                          </div>
            </div>

        </section>
    </noscript>

    <div class="application-root" id="application-root">
        <div class="toasts css-h56ruz"></div>
        <nav class="navbar is-transparent css-3fr1qq" role="navigation" aria-label="main navigation">
            <div class="container">
                <div class="navbar-brand">
                    <a class="navbar-item navbar-item-org-logo" href="/">
                        <img srcset="https://media.stellarlive.tech/w_51,h_48,c_scale/ewfrn2ixsg2ogfsv0kcy.png 1x, https://media.stellarlive.tech/w_102,h_96,c_scale/ewfrn2ixsg2ogfsv0kcy.png 2x" width="51" height="48" class="org-logo" alt="Timucua Arts Foundation" style="--org-logo-size:48px;">
                    </a>
                    <div role="button" class="navbar-burger burger" aria-label="menu" aria-expanded="false" data-target="navbar">
                        <span aria-hidden="true"></span>
                        <span aria-hidden="true"></span>
                        <span aria-hidden="true"></span>
                    </div>
                </div>
                <div id="navbar" class="navbar-menu">
                    <div class="navbar-start"></div>
                    <div class="navbar-end">
                        <a class="navbar-item has-text-weight-medium" href="/redeem">
                            Redeem
                            <span class="active-bar"></span>
                        </a>
                        <a href="https://www.stellartickets.com/wallet" class="navbar-item">
                            Your Tickets
                            <span class="active-bar"></span>
                        </a>
                        <div class="navbar-item has-dropdown">
                            <div class="navbar-link account-menu-control">Account</div>
                            <div class="navbar-dropdown is-right">
                                <a href="https://www.stellartickets.com/settings" class="navbar-item nested-navbar-item-with-icon">
                                    <ion-icon name="person-circle-outline" aria-label="person circle outline" role="img" class="md hydrated"></ion-icon>
                                    <span class="ml-2">Your Account</span>
                                </a>
                                <a href="https://www.stellartickets.com/purchases" class="navbar-item nested-navbar-item-with-icon">
                                    <ion-icon name="gift-outline" aria-label="gift outline" role="img" class="md hydrated"></ion-icon>
                                    <span class="ml-2">Your Purchases</span>
                                </a>
                                <a href="https://www.stellartickets.com/subscriptions" class="navbar-item nested-navbar-item-with-icon">
                                    <ion-icon name="refresh" aria-label="refresh" role="img" class="md hydrated"></ion-icon>
                                    <span class="ml-2">Your Subscriptions</span>
                                </a>
                                <a class="navbar-item nested-navbar-item-with-icon" href="/pages/help">
                                    <ion-icon name="help-circle-outline" aria-label="help circle outline" role="img" class="md hydrated"></ion-icon>
                                    <span class="ml-2">Help</span>
                                </a>
                                <hr class="navbar-divider">
                                <a href="https://www.stellartickets.com/dashboard" class="navbar-item nested-navbar-item-with-icon">
                                    <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" style="margin: 2px;">
                                        <title>Dashboard Icon</title>
                                        <defs>
                                            <path d="M0 0h16v16H0z"></path>
                                        </defs>
                                        <g fill="none" fill-rule="evenodd">
                                            <path d="M4.5 4.002a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1zm0 2a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4.883 6.226a.496.496 0 0 1-.383.157.496.496 0 0 1-.384-.157L5.604 9.945l-2.72 3.883a.5.5 0 0 1-.74 0 .584.584 0 0 1 0-.788L5.1 8.821a.488.488 0 0 1 .4-.15c.144-.01.29.032.4.15l3.022 2.29L13.1 6.155a.5.5 0 0 1 .739 0 .583.583 0 0 1 0 .788l-4.456 5.286zM15 1.5a.5.5 0 0 0-.5-.5h-13a.5.5 0 0 0-.5.5v13a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-13zM15 16H1a1 1 0 0 1-1-1V1a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1z" fill="currentColor"></path>
                                        </g>
                                    </svg>
                                    <span class="ml-2">Dashboard</span>
                                </a>
                            </div>
                        </div>
                        <a class="navbar-item navbar-item-with-icon" href="/cart">
                            <span class="icon is-relative">
                                <ion-icon name="cart-outline" aria-label="cart outline" role="img" class="md hydrated"></ion-icon>
                            </span>
                            <span class="is-hidden-tablet ml-2">Cart</span>
                        </a>
                        <a class="navbar-item has-text-weight-medium navbar-item-with-icon" href="/?modal=language">
                            <ion-icon name="globe-outline" aria-label="globe outline" role="img" class="md hydrated"></ion-icon>
                            <span class="is-hidden-tablet ml-2">Language</span>
                        </a>
                    </div>
                </div>
            </div>
        </nav>
        <div class="css-1ce57di">
            <section class="home-hero css-1mpgwh6" data-has-hero-image="true">
                <div class="inset home-hero-content">
                    <div class="desktop-hero-content header-alignment-center">
                        <h1 class="page-title">Timucua Arts Foundation</h1>
                        <div class="social-row">
                            <div class="social-icons css-su7zci">
                                <a href="https://instagram.com/timucuaarts" alt="Instagram account" class="social-icon" target="_blank" rel="noopener noreferrer">
                                    <span class="icon">
                                        <ion-icon name="logo-instagram" size="medium" aria-label="logo instagram" role="img" class="md icon-medium hydrated"></ion-icon>
                                    </span>
                                </a>
                                <a href="https://twitter.com/@TimucuaArts" alt="Twitter account" class="social-icon" target="_blank" rel="noopener noreferrer">
                                    <span class="icon">
                                        <ion-icon name="logo-twitter" size="medium" aria-label="logo twitter" role="img" class="md icon-medium hydrated"></ion-icon>
                                    </span>
                                </a>
                                <a href="https://www.facebook.com/timucuaartsfoundation" alt="Facebook url" class="social-icon" target="_blank" rel="noopener noreferrer">
                                    <span class="icon">
                                        <ion-icon name="logo-facebook" size="medium" aria-label="logo facebook" role="img" class="md icon-medium hydrated"></ion-icon>
                                    </span>
                                </a>
                                <a href="https://www.timucua.com/" alt="Website" class="social-icon" target="_blank" rel="noopener noreferrer">
                                    <span class="icon">
                                        <ion-icon name="globe-outline" size="medium" aria-label="globe outline" role="img" class="md icon-medium hydrated"></ion-icon>
                                    </span>
                                </a>
                            </div>
                        </div>
                    </div>
                    <div class="gallery css-nx4pnq">
                        <figure class="gallery-image">
                            <img srcset="https://media.stellarlive.tech/w_1360,h_765,c_fill,q_auto/agrdach02krub8mm7xsc.webp 1x, https://media.stellarlive.tech/w_2720,h_1530,c_fill,q_auto/agrdach02krub8mm7xsc.webp 2x" width="1360" height="765" class="css-ady3y5" alt="Timucua Arts Foundation">
                        </figure>
                    </div>
                </div>
            </section>
            <section class="inset inset-section">
                <h3 class="is-size-5 has-text-weight-bold is-uppercase mb-4 css-1b4c7u6">Event Bundles</h3>
                <div class="css-1oein7u">
                    <a class="card css-14xpkpa" href="/bundles/a4822110-59aa-47c4-aed0-375c839c689f">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/oq1nmelg7bmtbwgokvfu.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/oq1nmelg7bmtbwgokvfu.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <p class="title mb-0">Video on Demand Sampler</p>
                            <p class="subtitle mt-2"> $0.00 per bundle</p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/bundles/fbdc6c73-02a3-46f2-b4ff-5bd0cd05b1cb">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/haygcoo6omfbsnunb2fl.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/haygcoo6omfbsnunb2fl.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <p class="title mb-0">First International Guitar Festival</p>
                            <p class="subtitle mt-2"> $100.00 per bundle</p>
                        </div>
                    </a>
                </div>
            </section>
            <section class="inset inset-section">
                <h3 class="is-size-5 has-text-weight-bold is-uppercase mb-4 css-1b4c7u6">Events</h3>
                <div class="css-1ecj14j">
                    <div class="buttons my-2 css-1wsqsr1">
                        <label class="radio has-text-weight-bold css-zviajk" data-selected="true">
                            <input type="radio" name="date" class="css-zdnpxn" value="ALL_DATES" checked="">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="css-a85dzo">
                                <title>Circle</title>
                                <g fill="none" fill-rule="evenodd">
                                    <circle class="circle-border" cx="8" cy="8" r="7" stroke-width="1" fill="transparent"></circle>
                                    <circle class="circle-internal" cx="8" cy="8" r="5" stroke-width="1"></circle>
                                </g>
                            </svg>
                            All Dates
                        </label>
                        <label class="radio has-text-weight-bold css-zviajk" data-selected="false">
                            <input type="radio" name="date" class="css-zdnpxn" value="NEXT_7_DAYS">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="css-a85dzo">
                                <title>Circle</title>
                                <g fill="none" fill-rule="evenodd">
                                    <circle class="circle-border" cx="8" cy="8" r="7" stroke-width="1" fill="transparent"></circle>
                                    <circle class="circle-internal" cx="8" cy="8" r="5" stroke-width="1"></circle>
                                </g>
                            </svg>
                            Next 7 Days
                        </label>
                        <label class="radio has-text-weight-bold css-zviajk" data-selected="false">
                            <input type="radio" name="date" class="css-zdnpxn" value="NEXT_30_DAYS">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="css-a85dzo">
                                <title>Circle</title>
                                <g fill="none" fill-rule="evenodd">
                                    <circle class="circle-border" cx="8" cy="8" r="7" stroke-width="1" fill="transparent"></circle>
                                    <circle class="circle-internal" cx="8" cy="8" r="5" stroke-width="1"></circle>
                                </g>
                            </svg>
                            Next 30 Days
                        </label>
                    </div>
                    <div class="buttons my-2 css-nvcufe">
                        <label class="radio has-text-weight-bold css-zviajk" data-selected="true">
                            <input type="radio" name="ticket_types" class="css-zdnpxn" value="ALL" checked="">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="css-a85dzo">
                                <title>Circle</title>
                                <g fill="none" fill-rule="evenodd">
                                    <circle class="circle-border" cx="8" cy="8" r="7" stroke-width="1" fill="transparent"></circle>
                                    <circle class="circle-internal" cx="8" cy="8" r="5" stroke-width="1"></circle>
                                </g>
                            </svg>
                            All Events
                        </label>
                        <label class="radio has-text-weight-bold css-zviajk" data-selected="false">
                            <input type="radio" name="ticket_types" class="css-zdnpxn" value="LIVE_STREAM">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="css-a85dzo">
                                <title>Circle</title>
                                <g fill="none" fill-rule="evenodd">
                                    <circle class="circle-border" cx="8" cy="8" r="7" stroke-width="1" fill="transparent"></circle>
                                    <circle class="circle-internal" cx="8" cy="8" r="5" stroke-width="1"></circle>
                                </g>
                            </svg>
                            Livestream
                        </label>
                        <label class="radio has-text-weight-bold css-zviajk" data-selected="false">
                            <input type="radio" name="ticket_types" class="css-zdnpxn" value="VIDEO_ON_DEMAND">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="css-a85dzo">
                                <title>Circle</title>
                                <g fill="none" fill-rule="evenodd">
                                    <circle class="circle-border" cx="8" cy="8" r="7" stroke-width="1" fill="transparent"></circle>
                                    <circle class="circle-internal" cx="8" cy="8" r="5" stroke-width="1"></circle>
                                </g>
                            </svg>
                            On Demand
                        </label>
                        <label class="radio has-text-weight-bold css-zviajk" data-selected="false">
                            <input type="radio" name="ticket_types" class="css-zdnpxn" value="IN_PERSON">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" class="css-a85dzo">
                                <title>Circle</title>
                                <g fill="none" fill-rule="evenodd">
                                    <circle class="circle-border" cx="8" cy="8" r="7" stroke-width="1" fill="transparent"></circle>
                                    <circle class="circle-internal" cx="8" cy="8" r="5" stroke-width="1"></circle>
                                </g>
                            </svg>
                            In Person
                        </label>
                    </div>
                </div>
                <div class="is-flex mb-5 css-1c053el">
                    <h2 class="hero-subtitle has-text-weight-bold">26 Events</h2>
                </div>
                <div class="css-x3ui0p">
                    <a class="card css-14xpkpa" href="/events/open-house-ucf-faculty-brass-quintet">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/nkmqw35uswsbusj4r7jn.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/nkmqw35uswsbusj4r7jn.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Open House: UCF Faculty Brass Quintet</p>
                            <p class="subtitle mt-2">
                                <span data-id="2a12c7bb-879e-454b-9546-9001c3d429d0">
                                    <time datetime="2021-12-24T13:00:00Z">Dec 24, 2021</time>
                                    <br>
                                    <span>Available thru</span>
                                    <time datetime="2055-12-11T00:00:00Z">Dec 11, 2055</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-murieal-anderson-2-17">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/zzflg7fg2hfp0jeyritm.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/zzflg7fg2hfp0jeyritm.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Muriel Anderson</p>
                            <p class="subtitle mt-2">
                                <span data-id="a8d1e1a7-b38c-467f-954f-2096af814f0a">
                                    <time datetime="2022-02-18T00:30:00Z">Feb 18, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-leya">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/k7fi7cnhjah8xwfpzvdv.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/k7fi7cnhjah8xwfpzvdv.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: LEYA</p>
                            <p class="subtitle mt-2">
                                <span data-id="23b1c7cb-7f11-443a-8fc0-2610361f26b5">
                                    <time datetime="2022-03-23T23:30:00Z">Mar 23, 2022</time>
                                    <br>
                                    <span>Available thru</span>
                                    <time datetime="2104-02-01T00:00:00Z">Feb 1, 2104</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-matt-walden-2">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/zde3clyln2ytnpsuhhrc.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/zde3clyln2ytnpsuhhrc.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Matt Walden</p>
                            <p class="subtitle mt-2">
                                <span data-id="0dd50ff7-2072-448a-b97b-7a1281ac78bc">
                                    <time datetime="2022-05-06T23:30:00Z">May 6, 2022</time>
                                    <br>
                                    <span>Available thru</span>
                                    <time datetime="2111-05-16T00:00:00Z">May 16, 2111</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-bobby-callender-performing-the-way">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/k5ert7rhpzk0lztdab4t.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/k5ert7rhpzk0lztdab4t.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Bobby Callender performing The Way</p>
                            <p class="subtitle mt-2">
                                <time datetime="2022-06-03T23:30:00Z">Jun 3, 2022</time>
                                 - 
                                <time datetime="2022-06-04T23:30:00Z">Jun 4, 2022</time>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-the-lubben-brothers">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/mlgpfmjkp5fnbmzykp9z.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/mlgpfmjkp5fnbmzykp9z.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: The Lubben Brothers</p>
                            <p class="subtitle mt-2">
                                <span data-id="5ac6c6a3-78ca-40c0-b932-367a0f3e9176">
                                    <time datetime="2022-06-18T23:30:00Z">Jun 18, 2022</time>
                                    <br>
                                    <span>Available thru</span>
                                    <time datetime="2222-06-27T00:00:00Z">Jun 27, 2222</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-daniel-champagne-8-20">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/h16k5n8mebpl3b108lks.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/h16k5n8mebpl3b108lks.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Daniel Champagne</p>
                            <p class="subtitle mt-2">
                                <span data-id="e7c5aa16-67db-4a8a-bb23-46191f3654d0">
                                    <time datetime="2022-08-20T18:30:00Z">Aug 20, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/authentic-selves-poetry-reading-and-open-mic">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/lbk21fnfoop8un53lnkn.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/lbk21fnfoop8un53lnkn.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Authentic Selves: Poetry Reading and Open Mic</p>
                            <p class="subtitle mt-2">
                                <span data-id="ea21121c-136a-4238-ac3b-3372d4c829c9">
                                    <time datetime="2022-08-21T23:30:00Z">Aug 21, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/lat-don-soledad-8-26-22">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/dq93wyxfbpxvkujbpyqa.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/dq93wyxfbpxvkujbpyqa.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Don Soledad </p>
                            <p class="subtitle mt-2">
                                <span data-id="d517a9e6-05e2-47c9-ab21-036754753b28">
                                    <time datetime="2022-08-26T23:30:00Z">Aug 26, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-james-zito-trio">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/pqscmzarn5zakqiqvech.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/pqscmzarn5zakqiqvech.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: James Zito Trio</p>
                            <p class="subtitle mt-2">
                                <span data-id="2411e62d-24f9-41b4-b288-ccf45ea010c4">
                                    <time datetime="2022-08-27T23:30:00Z">Aug 27, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-catherine-britt">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/ezqrfk0zb0hujekmkz3l.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/ezqrfk0zb0hujekmkz3l.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Catherine Britt</p>
                            <p class="subtitle mt-2">
                                <span data-id="5e874aae-9c32-40a7-8b9b-700fb91531c5">
                                    <time datetime="2022-09-02T23:30:00Z">Sep 2, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-hiroya-tsukamoto">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/yf5kehmno21dhpyrtdgl.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/yf5kehmno21dhpyrtdgl.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Hiroya Tsukamoto</p>
                            <p class="subtitle mt-2">
                                <span data-id="d61f0606-fd16-428d-af1a-3c1666afb351">
                                    <time datetime="2022-09-03T23:30:00Z">Sep 3, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-anita-graef-and-julian-graef">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/wxa3ywdfhgyhza4fje5i.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/wxa3ywdfhgyhza4fje5i.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Anita Graef &amp; Julian Graef</p>
                            <p class="subtitle mt-2">
                                <span data-id="0fea1f08-59e3-4287-a71e-e417c0f60d10">
                                    <time datetime="2022-09-10T23:30:00Z">Sep 10, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/timucua-presents-alterity-chamber-orchestra">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/tyddhjmylpbi6uek3s33.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/tyddhjmylpbi6uek3s33.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Timucua Presents: Alterity Chamber Orchestra</p>
                            <p class="subtitle mt-2">
                                <span data-id="e15ea959-33da-4e40-9bab-26cb5234f773">
                                    <time datetime="2022-09-18T00:00:00Z">Sep 18, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/la-maestra-y-el-delantal-blanco">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/y35fxo6gumijzzbgrcht.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/y35fxo6gumijzzbgrcht.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">La Maestra y El Delantal Blanco</p>
                            <p class="subtitle mt-2">
                                <time datetime="2022-09-23T23:30:00Z">Sep 23, 2022</time>
                                 - 
                                <time datetime="2022-09-24T23:30:00Z">Sep 24, 2022</time>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-simon-lasky-group">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/z6ihwpnbj159asown2ob.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/z6ihwpnbj159asown2ob.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Simon Lasky Group</p>
                            <p class="subtitle mt-2">
                                <span data-id="ab50acbf-343f-4f38-a2a9-b010ffbad1b2">
                                    <time datetime="2022-09-25T23:30:00Z">Sep 25, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-no-5">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/kzmhpjg0cr9kt6x0knd5.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/kzmhpjg0cr9kt6x0knd5.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: No. 5, an opera about Coco Chanel</p>
                            <p class="subtitle mt-2">
                                <span data-id="592ff507-33eb-4380-992c-7fff51702253">
                                    <time datetime="2022-10-01T23:30:00Z">Oct 1, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-martin-bejerano-trio">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/my3b9p6jhjhkcel5ob8g.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/my3b9p6jhjhkcel5ob8g.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Martin Bejerano Trio</p>
                            <p class="subtitle mt-2">
                                <span data-id="ae939b44-fb50-4c79-8a70-381293a2541a">
                                    <time datetime="2022-10-07T23:30:00Z">Oct 7, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-kemuel-roig">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/rqlthhkubjlnxum2gld2.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/rqlthhkubjlnxum2gld2.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Kemuel Roig </p>
                            <p class="subtitle mt-2">
                                <span data-id="aa123107-27cf-4bab-9186-526782481cc2">
                                    <time datetime="2022-10-13T23:30:00Z">Oct 13, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/norman-westberg-of-swans-presented-by-the-modern-music-movement">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/jbaxdxoru3wijmgp6v7v.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/jbaxdxoru3wijmgp6v7v.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Norman Westberg of Swans, presented by The Modern Music Movement</p>
                            <p class="subtitle mt-2">
                                <span data-id="7594ef1d-9e22-4168-ab6a-17bafe0c2e50">
                                    <time datetime="2022-10-15T23:30:00Z">Oct 15, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/open-house-the-greenjays">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/z5aqw1zvph9nkv0jutfl.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/z5aqw1zvph9nkv0jutfl.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Open House: The Greenjays</p>
                            <p class="subtitle mt-2">
                                <span data-id="1c7b1dd6-fbac-42f9-9fa1-7af5495b42e1">
                                    <time datetime="2022-11-14T00:30:00Z">Nov 14, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-clive-carroll">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/ofc5ppjxygxqbua08yir.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/ofc5ppjxygxqbua08yir.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Clive Carroll</p>
                            <p class="subtitle mt-2">
                                <span data-id="a6561b9d-4225-4f52-a070-43ffb9ef05ee">
                                    <time datetime="2022-11-20T00:30:00Z">Nov 20, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/open-house-john-c-oleary-iii">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/istgd0gtey1kmvbhfn2l.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/istgd0gtey1kmvbhfn2l.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Open House: John C. O'Leary III</p>
                            <p class="subtitle mt-2">
                                <span data-id="42522356-5936-4ee4-b1df-263c3c67c819">
                                    <time datetime="2022-12-12T00:30:00Z">Dec 12, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-ulysses-quartet">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/icbnjjlyvklkojlyt3hi.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/icbnjjlyvklkojlyt3hi.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Ulysses Quartet</p>
                            <p class="subtitle mt-2">
                                <span data-id="3ad837f3-80a7-4d11-8213-22a73ab7f9de">
                                    <time datetime="2023-01-14T00:30:00Z">Jan 14, 2023</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-the-smoogies">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/i4ser89ajupagzqk4bak.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/i4ser89ajupagzqk4bak.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: The Smoogies</p>
                            <p class="subtitle mt-2">
                                <span data-id="5410dfd7-b3d2-42df-9a4c-30e517ecbe27">
                                    <time datetime="2023-04-28T23:30:00Z">Apr 28, 2023</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/events/live-at-timucua-maharajah-flamenco-trio">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/sak1pq2rdrrxozzmn5a6.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/sak1pq2rdrrxozzmn5a6.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="people" aria-label="people" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">In-person</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">On Demand</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Live at Timucua: Maharajah Flamenco Trio</p>
                            <p class="subtitle mt-2">
                                <span data-id="8f855f84-8415-44c2-b1a5-c3fc042ca072">
                                    <time datetime="2023-05-12T23:30:00Z">May 12, 2023</time>
                                </span>
                            </p>
                        </div>
                    </a>
                </div>
            </section>
            <section class="inset inset-section">
                <h3 class="is-size-5 has-text-weight-bold is-uppercase mb-4 css-1b4c7u6">Merchandise</h3>
                <div class="css-4mvrle">
                    <a class="card css-14xpkpa" href="/merch/360d9dd1-7c29-4ab8-9795-489441b0b9b6">
                        <div class="card-image">
                            <figure class="image is-1by1">
                                <img srcset="https://media.stellarlive.tech/b_auto,w_356,h_356,c_fill_pad,g_auto/bxcfz2hiva507wykog9j.webp 1x, https://media.stellarlive.tech/b_auto,w_712,h_712,c_fill_pad,g_auto/bxcfz2hiva507wykog9j.webp 2x" width="356" height="356" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <p class="title mb-0">2022 Month of Jazz Poster</p>
                            <p class="subtitle mt-2">$10.00</p>
                        </div>
                    </a>
                </div>
            </section>
            <div class="inset">
                <hr class="css-183yca4">
            </div>
            <section class="inset has-description css-1ueoyg1" id="about">
                <div class="about-organization">
                    <div class="about-content">
                        <div class="content">
                            <h3>Our mission is to inspire you with engaging experiences of the arts</h3>
                            <h3></h3>
                            <p>Timucua Arts Foundation is a multi-faceted arts and education institution, presenting concerts and festivals, operating the unique and intimate Timucua venue, and delivering education and wellness programming to people of all ages.</p>
                            <p>Timucua’s distinctive integration of the performing and visual arts has carved a niche for high-level, accessibly-priced programming in an intimate venue.</p>
                            <h3>Our values are rooted in community service, inclusivity, education, excellence, and sustainability</h3>
                            <h3></h3>
                            <p>Our core belief that The Arts Belong to Everyone is embodied in an expansive performance schedule unique in Central Florida, encompassing internationally-acclaimed jazz artists, indigenous and folkloric music and dance, contemporary classical music, avant-garde improvisation, film, site-specific theater, and more, all while visual artists work live on stage.</p>
                            <h3></h3>
                            <p>We believe:</p>
                            <p>Art and music belong to everyone.</p>
                            <p>Art and music are the highest manifestation of our humanity.</p>
                            <p>Art and music should be enjoyed in the most intimate venue: the living room.</p>
                            <p>Every community is better when art and music are performed and nurtured within it.</p>
                            <h3></h3>
                            <h3>The Timucua venue is located at 2000 S. Summerlin Ave  Orlando, Fl 32806, directly across from the Boone High School athletic fields.</h3>
                        </div>
                    </div>
                    <div class="about-links box">
                        <div class="about-links-content">
                            <div class="about-links-link">
                                <h6 class="title is-6">Website</h6>
                                <p>
                                    <a href="https://www.timucua.com/">https://www.timucua.com/</a>
                                </p>
                            </div>
                            <div class="about-links-link">
                                <h6 class="title is-6">Contact</h6>
                                <p>
                                    <a href="mailto:chris@timucua.com">chris@timucua.com</a>
                                </p>
                            </div>
                        </div>
                        <div class="social-icons css-su7zci">
                            <a href="https://instagram.com/timucuaarts" alt="Instagram account" class="social-icon" target="_blank" rel="noopener noreferrer">
                                <span class="icon">
                                    <ion-icon name="logo-instagram" size="medium" aria-label="logo instagram" role="img" class="md icon-medium hydrated"></ion-icon>
                                </span>
                            </a>
                            <a href="https://twitter.com/@TimucuaArts" alt="Twitter account" class="social-icon" target="_blank" rel="noopener noreferrer">
                                <span class="icon">
                                    <ion-icon name="logo-twitter" size="medium" aria-label="logo twitter" role="img" class="md icon-medium hydrated"></ion-icon>
                                </span>
                            </a>
                            <a href="https://www.facebook.com/timucuaartsfoundation" alt="Facebook url" class="social-icon" target="_blank" rel="noopener noreferrer">
                                <span class="icon">
                                    <ion-icon name="logo-facebook" size="medium" aria-label="logo facebook" role="img" class="md icon-medium hydrated"></ion-icon>
                                </span>
                            </a>
                            <a href="https://www.timucua.com/" alt="Website" class="social-icon" target="_blank" rel="noopener noreferrer">
                                <span class="icon">
                                    <ion-icon name="globe-outline" size="medium" aria-label="globe outline" role="img" class="md icon-medium hydrated"></ion-icon>
                                </span>
                            </a>
                        </div>
                    </div>
                </div>
            </section>
            <footer class="footer inset css-1gvckja">
                <a href="/">
                    <img srcset="https://media.stellarlive.tech/w_60,h_60,c_fill_pad,g_auto/ewfrn2ixsg2ogfsv0kcy.png 1x, https://media.stellarlive.tech/w_120,h_120,c_fill_pad,g_auto/ewfrn2ixsg2ogfsv0kcy.png 2x" width="60" height="60" alt="Timucua Arts Foundation">
                </a>
                <a href="https://www.stellartickets.com" class="powered-by-stellar-link">
                    powered by
                    <br>
                    <img src="https://static-assets.stellartickets.com/stellar-logo.svg?v2" width="120" height="28" alt="Stellar">
                </a>
            </footer>
        </div>
    </div>
</body>
</html>
  `;
  return new Response(body, {
    headers: {
      'content-type': 'text/html',
    }
  });
});

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
