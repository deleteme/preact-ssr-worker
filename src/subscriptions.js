import { html } from './html.js'
import { gql, useQuery } from './experiment-with-context.js'

export function Subscriptions(props) {
  const orgId = props.orgId

  const subscriptionResult = useQuery(
    gql`
      query OrgHomeSubscriptions($orgId: ID!) {
        organization(organizationId: $orgId) {
          id
          subscriptionProducts: products(
            where: {
              published: { equals: true }
              listed: { equals: true }
              type: { key: { equals: "subscription" } }
            }
          ) {
            nodes {
              id
            }
            totalCount
          }
        }
      }
    `,
    {
      variables: { orgId },
    },
  )
  console.log('subscriptionResult', JSON.stringify(subscriptionResult))
  const subscriptionsProducts =
    subscriptionResult.data &&
    subscriptionResult.data.organization.subscriptionProducts
  if (!subscriptionsProducts)
    return html`
      <em>loading subs</em>
    `

  return html`
    <section>
      <em>subscription ids</em>
      <pre>
      totalCount: ${subscriptionsProducts.totalCount}
    </pre
      >
      <table>
        <thead>
          <tr>
            <th>ID</th>
          </tr>
        </thead>
        <tbody>
          ${subscriptionsProducts.nodes.map(subscription => {
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
