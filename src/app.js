import { useState } from 'preact/hooks'
import { html } from './html.js'
import { Subscriptions } from "./subscriptions.js";

export function App(props = {}) {
  console.log('App() called with props', JSON.stringify(props))
  const [value, setValue] = useState(0)
  const { params, queryResult } = props
  //console.log('params', params);
  const page = params && params.page
  const organization = queryResult.data.organization
  return html`
    <header>
      <h1>
        app, <em>in html!</em>
        ${organization.name}
      </h1>
      <nav>
        <a href="/">Home</a>
        <a href="/pages/about">About</a>
        <a href="/pages/subscriptions">Subscriptions</a>
      </nav>
    </header>
    <main>
      <h1>
        ${!params && 'Home'}
        ${page === 'about' && 'About'}
        ${page === 'subscriptions' && 'Subscriptions'}
      </h1>
      ${page === 'subscriptions' && Subscriptions({
        queryResult
      })}
    </main>
    <footer>
      foot
      <br />
      ${value}
      <button type="button" onClick=${() => setValue(value === 0 ? 1 : 0)}>
        toggle
      </button>
    </footer>
  `
}
