import { html } from './html.js'
import { useQuery } from "./experiment-with-context.js";

export function Subscriptions(props) {
  const subscriptions = props.queryResult.data.organization.subscriptionProducts.nodes;

  const q2 = useQuery(`query faked {
    organization {
      id
    }
  }`, {
    variables: { a: 1 }
  });
  console.log('q2', JSON.stringify(q2));

  return html`<section>
    <em>subscription ids</em>
    <pre>
      ${JSON.stringify(q2)}
    </pre>
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
  </section>`;
}
