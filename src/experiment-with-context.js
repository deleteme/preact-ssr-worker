import { createContext } from 'preact';
import { useContext, useEffect, useRef } from 'preact/hooks';

console.log('calling experiment-with-context.js');

class Collection {
  constructor() {
    this.state = new Map();
  }
  register(id, item) {
    console.log('collection.register called with id, item', id, JSON.stringify(item));
    this.state.set(id, item);
    return id;
  }
  unregister(id) {
    this.state.delete(id);
  }
  getNextId() {
    return this.state.size;
  }
  async process(callback) {
    for (const item of this.state) {
      await callback(item);
    }
    this.state.clear();
  }
}

export const collection = new Collection();

export const CollectionContext = createContext(collection);

export const useQuery = (ql, options) => {
  const collection = useContext(CollectionContext);
  const idRef = useRef(collection.getNextId());
  const id = idRef.current;
  const queryRef = useRef(collection.register(id, [ql, options]));

  useEffect(() => {
    return () => {
      collection.unregister(id);
    };
  }, [id]);
  return { idRef, queryRef, collection };
};
