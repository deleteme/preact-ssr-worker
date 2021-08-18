import { createContext } from 'preact';
import { useContext, useEffect } from 'preact/hooks';

//class PendingQuery {
  //constructor(graphQLString, options) {
    //this.graphQLString = graphQLString;
    //this.options = options;
    //this.status = 'pending';
  //}
//}

//class QueryClient {
  //constructor() {
    //this._queries = new Map();
  //}
  //addQuery(graphQLString, options) {
    //const pendingQuery = new PendingQuery(graphQLString, options);
    //this._queries.set(graphQLString, options);
  //}
  //removeQuery(graphQLString) {
    //this._queries.delete(graphQLString, options);
  //}
  //getQueries() {
    //return this._queries;
  //}
//}

//const QueryContext = createContext(new QueryClient());

//const useQuery = (graphQLString, options) => {
  //const client = useContext(QueryContext);
  //const initialEntry = [graphQLString, options];
  //const ref = useRef(initialEntry);
  //useEffect(() => {
    //console.log('useEffect hook called');
  //}, [client, graphQLString, options]);
//};

const gql = (strings, ...args) => {
  let rendered = ''
  let i = 0
  while (strings[i] !== undefined) {
    rendered += strings[i]
    if (args[i] !== undefined) {
      rendered += args[i]
    }
    i += 1
  }
  return rendered
}

const apiAccessToken = 'cQtJhHPJr9kwSA5vlYoriresrBzdm2LTZGe3d7'

export const query = () => {
  console.log('query() called')
  const url = 'https://staging.stellartickets.com/graphql'
  const body = {
    operationName: 'OrgHomeSubscriptions',
    variables: { orgSlug: 'bobs-party-time-lounge' },
    query: gql`
      query OrgHomeSubscriptions($orgSlug: String, $domain: String) {
        organization(slug: $orgSlug, domain: $domain) {
          id
          name
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
    //'query OrgHomeSubscriptions($orgSlug: String, $domain: String) {\n  organization(slug: $orgSlug, domain: $domain) {\n    id\n    subscriptionProducts: products(where: {published: {equals: true}, listed: {equals: true}, type: {key: {equals: "subscription"}}}) {\n      nodes {\n        id\n        ... on SubscriptionProduct {\n          name\n          inventories {\n            id\n            pricePoints {\n              id\n              name\n              price {\n                formatted\n                __typename\n              }\n              recurring {\n                interval\n                intervalCount\n                __typename\n              }\n              __typename\n            }\n            __typename\n          }\n          assetAssignments {\n            ...AssetAssignmentFragment\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n\nfragment AssetAssignmentFragment on AssetAssignment {\n  id\n  transformations\n  asset {\n    id\n    width\n    height\n    secureUrl\n    publicId\n    resourceType\n    __typename\n  }\n  assetSlot {\n    id\n    aspectRatio\n    placement\n    displayName\n    resourceType\n    __typename\n  }\n  __typename\n}\n',
  }
  console.log('body', body)
  return fetch(url, {
    method: 'post',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiAccessToken}`,
    },
    body: JSON.stringify(body),
  })
}
