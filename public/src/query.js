import { createContext } from 'preact'
import { useContext, useEffect } from 'preact/hooks'

export const gql = (strings, ...args) => {
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

export const fetchQuery = async (query, options = {}) => {
  console.log('fetchQuery called with', query, options)
  const { variables, operationName, origin = '' } = options
  const body = { operationName, variables, query }
  console.log('fetchQuery body', JSON.stringify(body))
  const url = origin + '/graphql'
  const response = await fetch(url, {
    method: 'post',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${apiAccessToken}`,
    },
    body: JSON.stringify(body),
  })
  console.log('fetchQuery response.status', response.status)
  return response
}
