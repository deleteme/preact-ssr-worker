import { html } from './html.js'

export function Subscriptions(props) {
  const subscriptions =
    props.queryResult.data.organization.subscriptionProducts.nodes
  return html`
    <section>
      <em>subscription ids</em>
      <table>
        <thead>
          <tr>
            <th>ID</th>
          </tr>
        </thead>
        <tbody>
          ${subscriptions.map(subscription => {
            return html`
              <tr>
                <td>${subscription.id}</td>
              </tr>
            `
          })}
        </tbody>
      </table>
    </section>
  `
}
