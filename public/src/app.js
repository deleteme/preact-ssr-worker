import { useState, useEffect, useRef } from 'preact/hooks'
import { html } from './html.js'
import { Subscriptions } from './subscriptions.js'
import { useQuery, CollectionContext, gql } from './experiment-with-context.js'
import { Router } from './router.js'

const Layout = props => {
  const [value, setValue] = useState(0)
  const { params } = props
  const page = params && params.page
  const orgResult = useQuery(
    gql`
      query Organization($id: ID!) {
        organization(organizationId: $id) {
          id
          name
        }
      }
    `,
    { variables: { id: 'fcbf1994-4b35-451d-bffb-90cb6032f42b' } },
  )
  const organization = orgResult.data && orgResult.data.organization
  console.log('org orgResult', orgResult)
  if (!organization) return ``
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
        ${!page && 'Home'} ${page === 'about' && 'About'}
        ${page === 'subscriptions' && 'Subscriptions'}
      </h1>
      ${page === 'subscriptions' &&
        Subscriptions({
          orgId: organization.id,
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

export function App(props = {}) {
  console.log('\nApp() called with props', JSON.stringify(props))
  const { collection, routes } = props
  const children = ({ params }) => html`
    <${CollectionContext.Provider} value=${collection}>
      <${Layout} ...${props} params=${params}><//>
    <//>
  `
  return html`
    <${Router} routes=${routes}>${children}<//>
  `
}
