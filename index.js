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

router.get('/test-twitter-card', () => {
  const body = `
  <!DOCTYPE html>
<html class="hydrated">
<head>
    <base href="https://www.stellartickets.com">
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
    <link id="organizations_stylesheet" rel="stylesheet" href="https://assets.stellartickets.com/dist/organizations-root-50ff3ac6cb60bea69a011b6601ad42a1af1faab7.css" media="all" crossorigin="anonymous">
    <link id="organizations_dark_stylesheet" rel="stylesheet" href="https://assets.stellartickets.com/dist/organizations-root-dark-50ff3ac6cb60bea69a011b6601ad42a1af1faab7.css" media="all" crossorigin="anonymous">
    <link id="consumer_stylesheet" rel="stylesheet" href="https://assets.stellartickets.com/dist/root-50ff3ac6cb60bea69a011b6601ad42a1af1faab7.css" media="all" crossorigin="anonymous">

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
    .css-1b4c7u6 {
        letter-spacing: 4px;
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
    <meta charset="utf-8">
    <title>Misfit Cabaret • Stellar Tickets</title>
    <meta property="og:type" content="website" data-rh="true">
    <meta property="twitter:card" content="summary_large_image" data-rh="true">
    <meta property="og:title" content="Misfit Cabaret" data-rh="true">
    <meta property="twitter:title" content="Misfit Cabaret" data-rh="true">
    <meta name="title" content="Misfit Cabaret" data-rh="true">
    <meta property="og:image" content="https://media.stellarlive.tech/c_fill,q_auto/b4p0eccmvw4pdo1mwipx.webp" data-rh="true">
    <meta property="twitter:image" content="https://media.stellarlive.tech/c_fill,q_auto/b4p0eccmvw4pdo1mwipx.webp" data-rh="true">
    <meta property="og:description" content="Misfit Cabaret is a splendiferous variety show centered around magical music with a rotating cast of eccentric performers. From burlesque to drag to circus to magic, you never know what you're going to see (or what you're getting yourself into)! For each new Misfit Cabaret, emcee Kat Robichaud writes two original songs keeping with the theme of the evening and plays them with her Darling Misfit band, as well as a special medley to kick off the evening and welcome in the spirits of San Francisco'" data-rh="true">
    <meta property="twitter:description" content="Misfit Cabaret is a splendiferous variety show centered around magical music with a rotating cast of eccentric performers. From burlesque to drag to circus to magic, you never know what you're going to see (or what you're getting yourself into)! For each new Misfit Cabaret, emcee Kat Robichaud writes two original songs keeping with the theme of the evening and plays them with her Darling Misfit band, as well as a special medley to kick off the evening and welcome in the spirits of San Francisco'" data-rh="true">
    <meta name="description" content="Misfit Cabaret is a splendiferous variety show centered around magical music with a rotating cast of eccentric performers. From burlesque to drag to circus to magic, you never know what you're going to see (or what you're getting yourself into)! For each new Misfit Cabaret, emcee Kat Robichaud writes two original songs keeping with the theme of the evening and plays them with her Darling Misfit band, as well as a special medley to kick off the evening and welcome in the spirits of San Francisco'" data-rh="true">
    <base href="https://www.stellartickets.com">
</head>
<body>
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
                    <a class="navbar-item navbar-item-org-logo" href="/o/misfit-cabaret-llc--2">
                        <img srcset="https://media.stellarlive.tech/w_48,h_48,c_scale/hyuyfyl83a5g9wff3jyn.png 1x, https://media.stellarlive.tech/w_96,h_96,c_scale/hyuyfyl83a5g9wff3jyn.png 2x" width="48" height="48" class="org-logo" alt="Misfit Cabaret LLC" style="--org-logo-size:48px;">
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
                        <a class="navbar-item has-text-weight-medium" href="/o/misfit-cabaret-llc--2/redeem">
                            Redeem
                            <span class="active-bar"></span>
                        </a>
                        <a class="navbar-item search" href="/search">
                            <ion-icon name="search-outline" aria-label="search outline" role="img" class="md hydrated"></ion-icon>
                            <span>Search</span>
                        </a>
                        <a class="navbar-item" href="/wallet">
                            Your Tickets
                            <span class="active-bar"></span>
                        </a>
                        <div class="navbar-item has-dropdown">
                            <div class="navbar-link account-menu-control">Account</div>
                            <div class="navbar-dropdown is-right">
                                <a class="navbar-item nested-navbar-item-with-icon" href="/log-in">
                                    <ion-icon name="enter-outline" aria-label="enter outline" role="img" class="md hydrated"></ion-icon>
                                    <span class="ml-2">Log In</span>
                                </a>
                                <hr class="navbar-divider">
                                <a class="navbar-item nested-navbar-item-with-icon" href="/settings">
                                    <ion-icon name="person-circle-outline" aria-label="person circle outline" role="img" class="md hydrated"></ion-icon>
                                    <span class="ml-2">Your Account</span>
                                </a>
                                <a class="navbar-item nested-navbar-item-with-icon" href="/purchases">
                                    <ion-icon name="gift-outline" aria-label="gift outline" role="img" class="md hydrated"></ion-icon>
                                    <span class="ml-2">Your Purchases</span>
                                </a>
                                <a class="navbar-item nested-navbar-item-with-icon" href="/subscriptions">
                                    <ion-icon name="refresh" aria-label="refresh" role="img" class="md hydrated"></ion-icon>
                                    <span class="ml-2">Your Subscriptions</span>
                                </a>
                                <a class="navbar-item nested-navbar-item-with-icon" href="/pages/help">
                                    <ion-icon name="help-circle-outline" aria-label="help circle outline" role="img" class="md hydrated"></ion-icon>
                                    <span class="ml-2">Help</span>
                                </a>
                                <hr class="navbar-divider">
                                <a class="navbar-item nested-navbar-item-with-icon" href="/dashboard">
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
                        <a class="navbar-item navbar-item-with-icon" href="/o/misfit-cabaret-llc--2/cart">
                            <span class="icon is-relative">
                                <ion-icon name="cart-outline" aria-label="cart outline" role="img" class="md hydrated"></ion-icon>
                            </span>
                            <span class="is-hidden-tablet ml-2">Cart</span>
                        </a>
                        <a class="navbar-item has-text-weight-medium navbar-item-with-icon" href="/o/misfit-cabaret-llc--2?modal=language">
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
                    <div class="desktop-hero-content header-alignment-justify">
                        <h1 class="page-title">Misfit Cabaret</h1>
                        <div class="social-row">
                            <div class="social-icons css-su7zci">
                                <a href="http://www.krmisfitcabaret.com" alt="Website" class="social-icon" target="_blank" rel="noopener noreferrer">
                                    <span class="icon">
                                        <ion-icon name="globe-outline" size="medium" aria-label="globe outline" role="img" class="md icon-medium hydrated"></ion-icon>
                                    </span>
                                </a>
                            </div>
                        </div>
                    </div>
                    <div class="gallery css-nx4pnq">
                        <figure class="gallery-image">
                            <img srcset="https://media.stellarlive.tech/w_1360,h_765,c_fill,q_auto/b4p0eccmvw4pdo1mwipx.webp 1x, https://media.stellarlive.tech/w_2720,h_1530,c_fill,q_auto/b4p0eccmvw4pdo1mwipx.webp 2x" width="1360" height="765" class="css-ady3y5" alt="Misfit Cabaret LLC">
                        </figure>
                    </div>
                </div>
            </section>
            <section class="inset inset-section">
                <h3 class="is-size-5 has-text-weight-bold is-uppercase mb-4 css-1b4c7u6">Events</h3>
                <div class="is-flex mb-5 css-1c053el">
                    <h2 class="hero-subtitle has-text-weight-bold">3 Events</h2>
                </div>
                <div class="css-x3ui0p">
                    <a class="card css-14xpkpa" href="/o/misfit-cabaret-llc--2/events/misfit-cabaret-presents-circus">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/yvpkle59bwquzixhcjoi.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/yvpkle59bwquzixhcjoi.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
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
                            <p class="title mb-0">Misfit Cabaret Presents Circus</p>
                            <p class="subtitle mt-2">
                                <span data-id="baf1dc05-00e9-44e1-b426-f1fe21da9f4f">
                                    <time datetime="2022-08-20T00:00:00Z">Aug 20, 2022</time>
                                    <br>
                                    <span>Available thru</span>
                                    <time datetime="2022-08-24T23:00:00Z">Aug 24, 2022</time>
                                </span>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/o/misfit-cabaret-llc--2/events/misfit-cabaret-presents-asylum">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/kbijnjx2jp5jhunxxlrv.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/kbijnjx2jp5jhunxxlrv.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
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
                            <p class="title mb-0">Misfit Cabaret Presents Asylum</p>
                            <p class="subtitle mt-2">
                                <time datetime="2022-09-18T00:00:00Z">Sep 18, 2022</time>
                                 - 
                                <time datetime="2022-10-09T03:00:00Z">Oct 9, 2022</time>
                            </p>
                        </div>
                    </a>
                    <a class="card css-14xpkpa" href="/o/misfit-cabaret-llc--2/events/misfit-cabaret-presents-night-terrors">
                        <div class="card-image">
                            <figure class="image is-16by9">
                                <img srcset="https://media.stellarlive.tech/w_720,h_405,c_fill,q_auto/ysb0rsolv7oeljansayq.webp 1x, https://media.stellarlive.tech/w_1440,h_810,c_fill,q_auto/ysb0rsolv7oeljansayq.webp 2x" width="720" height="405" loading="lazy">
                            </figure>
                        </div>
                        <div class="card-content">
                            <div class="field is-grouped mb-0 mb-1 css-1wm5blw">
                                <div class="control">
                                    <span class="tags has-addons">
                                        <span class="tag">
                                            <ion-icon name="videocam" aria-label="videocam" role="img" class="md hydrated"></ion-icon>
                                        </span>
                                        <span class="tag">Livestream</span>
                                    </span>
                                </div>
                            </div>
                            <p class="title mb-0">Misfit Cabaret Presents Night Terrors</p>
                            <p class="subtitle mt-2">
                                <span data-id="8b395027-ab8d-431d-bf58-be470248d2e3">
                                    <time datetime="2022-10-09T03:00:00Z">Oct 9, 2022</time>
                                </span>
                            </p>
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
                            <p>Misfit Cabaret is a splendiferous variety show centered around magical music with a rotating cast of eccentric performers. From burlesque to drag to circus to magic, you never know what you're going to see (or what you're getting yourself into)! For each new Misfit Cabaret, emcee Kat Robichaud writes two original songs keeping with the theme of the evening and plays them with her Darling Misfit band, as well as a special medley to kick off the evening and welcome in the spirits of San Francisco's saucy past!</p>
                        </div>
                    </div>
                    <div class="about-links box">
                        <div class="about-links-content">
                            <div class="about-links-link">
                                <h6 class="title is-6">Website</h6>
                                <p>
                                    <a href="http://www.krmisfitcabaret.com">http://www.krmisfitcabaret.com</a>
                                </p>
                            </div>
                            <div class="about-links-link">
                                <h6 class="title is-6">Contact</h6>
                                <p>
                                    <a href="mailto:jordanathan21@gmail.com">jordanathan21@gmail.com</a>
                                </p>
                            </div>
                        </div>
                        <div class="social-icons css-su7zci">
                            <a href="http://www.krmisfitcabaret.com" alt="Website" class="social-icon" target="_blank" rel="noopener noreferrer">
                                <span class="icon">
                                    <ion-icon name="globe-outline" size="medium" aria-label="globe outline" role="img" class="md icon-medium hydrated"></ion-icon>
                                </span>
                            </a>
                        </div>
                    </div>
                </div>
            </section>
            <footer class="footer inset css-1gvckja">
                <a href="/o/misfit-cabaret-llc--2">
                    <img srcset="https://media.stellarlive.tech/w_60,h_60,c_fill_pad,g_auto/hyuyfyl83a5g9wff3jyn.png 1x, https://media.stellarlive.tech/w_120,h_120,c_fill_pad,g_auto/hyuyfyl83a5g9wff3jyn.png 2x" width="60" height="60" alt="Misfit Cabaret LLC">
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
