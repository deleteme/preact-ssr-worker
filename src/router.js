import { parse } from 'regexparam'
import { useReducer, useEffect } from 'preact/hooks'
import { html } from './html.js'

function exec(path, result) {
  let i = 0,
    out = {}
  let matches = result.pattern.exec(path)
  while (i < result.keys.length) {
    out[result.keys[i]] = matches[++i] || null
  }
  return out
}

let initialUrl = ''
try {
  initialUrl = new URL(window.location.href)
} catch (e) {}

const getAppHistory = () => {
  console.log('getAppHistory() called')
  let api
  try {
    api = window.appHistory
    if (api) return api
  } catch (e) {
    console.log('throwing on getAppHistory()', e)
  }
}

const getParamsFromRoutes = (routes, pathname) => {
  for (const route of routes) {
    const params = getParamsFromRoute(route, pathname)
    if (params) return params
  }
}

const getParamsFromRoute = (route, pathname) => {
  const result = parse(route)
  const isMatch = result.pattern.test(pathname)
  if (isMatch) {
    const params = exec(pathname, result)
    return params
  }
}

export const Router = ({ routes, children, initialState }) => {
  console.log('Router called with', routes, children, initialState)
  console.log(
    'Router, calling useReducer with initialState',
    initialState.url,
    initialState.params,
  )
  const [state, dispatch] = useReducer((state, action) => {
    console.log('reducer fn called with action', JSON.stringify(action))
    const { type, params, url } = action
    if (type === 'navigate') {
      return { params, url }
    }
  }, initialState)
  console.log('<Router> useReducer returned state:', state)

  console.log('Router, calling useEffect')
  useEffect(() => {
    console.log('Router useEffect cb called.')
    const appHistory = getAppHistory()
    if (!appHistory) return
    const handleNavigate = event => {
      const url = new URL(event.destination.url)
      const { pathname } = url

      const params = getParamsFromRoutes(routes, pathname)
      if (params) {
        event.transitionWhile(
          (async => {
            dispatch({ type: 'navigate', params, url: url.toString() })
          })(),
        )
      }
    }
    appHistory.addEventListener('navigate', handleNavigate)
    return () => appHistory.removeEventListener('navigate', handleNavigate)
  }, [routes])
  console.log('Router is returning now.')

  return html`
    ${children({ params: state.params, url: state.url })}
  `
}
