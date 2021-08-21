import { createContext } from 'preact'
import { useContext, useEffect, useRef, useReducer } from 'preact/hooks'
import { fetchQuery, gql } from '../query.js'

export { gql }

console.log('calling experiment-with-context.js')

class Collection {
  constructor() {
    this.lastProvisionedId = null
    this.ids = []
    this.pending = new Map()
    this.processed = new Map()
  }
  register(idRef, item) {
    if (idRef.current === null) {
      console.log('idRef.current is null. assigning an id')
      idRef.current = this.getNextId()
      /*
      const isFresh = this.processed.size === 0;
      // 1st pass. starting from scratch. make new ids.
      if (isFresh) {
        idRef.current = this.getNextId();
      } else {
        // has processed queries

        either the id is a processed id
          and needs to be restored
          idRef.current = 0
        or it's a new one
          idRef.current = this.getNextId();


        //const hasNewPendingQueries = this.pending.size > 0;
        //if (hasNewPendingQueries) {
        //} else {
        //}
        // 1 = 1 - 0
        //
        idRef.current = this.processed.size - this.pending.size;
        // Are any pending
      }
      */
    }
    const id = idRef.current
    console.log(
      'collection.register called with idRef, item',
      id,
      JSON.stringify(item),
    )
    console.log('added idRef to set', this.ids)
    if (this.processed.has(id)) {
      console.log(
        'collection register called with an idRef it already has processed. return previous query.',
      )
      return this.processed.get(id)
    } else {
      this.ids.push(id)
      this.pending.set(id, item)
      return item
    }
  }
  unregister(idRef) {
    const id = idRef.current
    this.ids = this.ids.filter(_id => _id !== id)
    this.pending.delete(id)
    this.processed.delete(id)
  }
  getNextId() {
    if (this.lastProvisionedId === null) {
      this.lastProvisionedId = 0
    } else {
      this.lastProvisionedId += 1
    }
    return this.lastProvisionedId
    //return this.ids.length
  }
  async process() {
    console.log('processing started')
    this.lastProvisionedId = null
    for (const [id, item] of this.pending.entries()) {
      console.log(id, item, 'query.status === PENDING', item.status === PENDING)
      if (item.status === PENDING) {
        console.log('requesting query', item.query)
        await item.call()
        this.pending.delete(id)
        this.processed.set(id, item)
      }
    }
    console.log('processing ending')
  }
}
const PENDING = 'PENDING'
const LOADING = 'LOADING'
const RESOLVED = 'RESOLVED'
const REJECTED = 'REJECTED'

class Query {
  constructor(query, options = {}) {
    this.status = PENDING
    this.response = null
    this.responseJSON = null
    this.error = null

    this.query = query
    this.operationName = options.operationName
    this.variables = options.variables
  }
  async call() {
    try {
      this.status = LOADING
      this.response = await fetchQuery(this.query, {
        operationName: this.operationName,
        variables: this.variables,
      })
      console.log('this.response.status', this.response.status)
      try {
        this.responseJSON = await this.response.json()
        console.log('setting responseJSON', JSON.stringify(this.responseJSON))
      } catch (error) {
        console.log('error parsing json', error.message)
      }
      this.status = RESOLVED
    } catch (error) {
      console.log(
        'fetchQuery failed with error:',
        JSON.stringify(error.message),
      )
      this.status = REJECTED
      this.error = error
    }
    return this
  }
}

export const collection = new Collection()

export const CollectionContext = createContext(collection)

const queryReducer = (state = initialState, action) => {
  switch (action.type) {
    case 'LOAD': {
      return { ...state, status: LOADING, loading: true }
    }
    case 'RESOLVE': {
      return { ...state, status: RESOLVED, data: action.data, loading: false }
    }
    case 'REJECT': {
      return { ...state, status: REJECTED, error: action.error, loading: false }
    }
    default: {
      throw new Error('Unhandled action type given: ' + action.type)
    }
  }
}

export const useQuery = (gql, options) => {
  console.log('useQuery called with', gql, options)
  const collection = useContext(CollectionContext)
  const idRef = useRef(null)
  const queryRef = useRef(collection.register(idRef, new Query(gql, options)))
  const query = queryRef.current

  useEffect(() => {
    return () => {
      collection.unregister(idRef)
    }
  }, [idRef])

  const initialState = {
    loading: query.status === LOADING,
    status: query.status,
    error: query.error,
    data: query.responseJSON ? query.responseJSON.data : null,
  }
  const [result, dispatch] = useReducer(queryReducer, initialState)

  const status = result.status

  useEffect(() => {
    const query = queryRef.current
    if (status === PENDING) {
      ;(async () => {
        try {
          dispatch({ type: 'LOAD' })
          const response = await query.call()
          dispatch({ type: 'RESOLVE', data: response.responseJSON.data })
        } catch (error) {
          console.error(error)
          dispatch({ type: 'REJECT', error })
        }
      })()
    }
  }, [queryRef, dispatch, status])
  console.log('useQuery hook returning result:', result)

  return result
}
