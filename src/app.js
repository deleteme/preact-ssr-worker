import { useState } from 'preact/hooks'
import { html } from './html.js'

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
      </nav>
    </header>
    <main>
      <h1>
        ${!params && 'Home'} ${page === 'about' && 'About'}
      </h1>
      ${page}
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
