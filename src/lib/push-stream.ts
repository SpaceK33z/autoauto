export interface PushStream<T> extends AsyncIterable<T> {
  push(value: T): void
  end(): void
}

export function createPushStream<T>(): PushStream<T> {
  const queue: T[] = []
  let waiting: ((result: IteratorResult<T>) => void) | null = null
  let done = false

  return {
    push(value: T) {
      if (done) return
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value, done: false })
      } else {
        queue.push(value)
      }
    },

    end() {
      done = true
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value: undefined as never, done: true })
      }
    },

    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false })
          }
          if (done) {
            return Promise.resolve({ value: undefined as never, done: true })
          }
          return new Promise((resolve) => {
            waiting = resolve
          })
        },
      }
    },
  }
}
