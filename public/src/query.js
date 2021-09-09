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

export const fetchQuery = async (query, options = {}) => {
  console.log('fetchQuery called with', query, options)
  const { variables, operationName, origin = '', headers } = options
  const body = { operationName, variables, query }
  console.log('fetchQuery body', JSON.stringify(body))
  const url = origin + '/graphql'
  const response = await fetch(url, {
    method: 'post',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
  console.log('fetchQuery response.status', response.status)
  return response
}
