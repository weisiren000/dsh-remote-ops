// 同一 key 的任务串行执行；不同 key 保持并发，失败不会污染后续队列。
export function createKeyedLock() {
  const tails = new Map()
  return async function withKeyLock(key, task) {
    const previous = tails.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const tail = previous.catch(() => {}).then(() => gate)
    tails.set(key, tail)
    await previous.catch(() => {})
    try {
      return await task()
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }
}
