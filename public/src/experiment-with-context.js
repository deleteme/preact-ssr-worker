import { createContext } from 'preact'
import { useContext, useEffect, useRef, useReducer } from 'preact/hooks'
import { fetchQuery, gql } from './query.js'

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
    }
    const id = idRef.current
    console.log(
      'collection.register called with idRef, item',
      id,
      JSON.stringify(item),
    )
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
  toJSON() {
    const processed = Array.from(this.processed);
    const pending = Array.from(this.pending);
    return ({
      lastProvisionedId: this.lastProvisionedId,
      ids: this.ids,
      processed,
      pending
    })
  }
  restore(parsed) {
    console.log('collection.restore called with', parsed);
    //const parsed = JSON.parse(string);
    this.lastProvisionedId = parsed.lastProvisionedId;
    this.ids = parsed.ids;

    const makeQuery = q => {
      const query = new Query(q.query, {
        operationName: q.operationName,
        variables: q.variables
      });
      query.restore(q);
      return query;
    };

    this.pending = new Map(parsed.pending.map((q, id) => {
      return [id, makeQuery(q)];
    }));
    this.processed = new Map(parsed.processed.map((q, id) => {
      return [id, makeQuery(q)];
    }));
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
    this.data = null
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
        const responseJSON = await this.response.json()
        this.data = responseJSON.data;
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
  toJSON() {
    const { status, data, error, query, operationName, variables } = this;
    return ({ status, data, error, query, operationName, variables });
  }
  restore(parsed) {
    console.log('Query.restore() called with', parsed);
    this.status = parsed.status;
    this.data = parsed.data;
    this.error = parsed.error
    this.query = parsed.query;
    this.operationName = parsed.operationName;
    this.variables = parsed.variables;
  }
  //fromString(string) {
    //const parsed = JSON.parse(string);
    //this.status = parsed.status;
    //this.data = parsed.data;
    //this.error = parsed.error
    //this.query = parsed.query;
    //this.operationName = parsed.operationName;
    //this.variables = parsed.variables;
  //}
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
    data: query.data
  }
  const [result, dispatch] = useReducer(queryReducer, initialState)

  const status = result.status

  useEffect(() => {
    const query = queryRef.current
    if (status === PENDING) {
      ;(async () => {
        try {
          dispatch({ type: 'LOAD' })
          const result = await query.call()
          dispatch({ type: 'RESOLVE', data: result.data })
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
