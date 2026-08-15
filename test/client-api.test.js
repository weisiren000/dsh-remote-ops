import test from 'node:test'
import assert from 'node:assert/strict'
import { reduceHostsState } from '../src/plugin/client-api.js'

test('加载失败不冲掉已有列表', () => {
  const state = {
    error: null,
    hosts: [{ host_id: 'h1', display_name: 'one' }],
    currentHostId: 'h1',
  }
  const next = reduceHostsState(state, { type: 'load-error', message: 'loopback only' })
  assert.equal(next.error, 'loopback only')
  assert.equal(next.hosts[0].host_id, 'h1')
})

test('配对成功写入列表并在标记当前时切换目标', () => {
  const state = { error: 'old', hosts: [], currentHostId: null }
  const next = reduceHostsState(state, {
    type: 'paired',
    host: { host_id: 'h2', display_name: 'two', current: true },
  })
  assert.equal(next.error, null)
  assert.equal(next.currentHostId, 'h2')
  assert.equal(next.hosts[0].host_id, 'h2')
})
