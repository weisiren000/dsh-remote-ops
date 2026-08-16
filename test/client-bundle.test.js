import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)

test('远程工作台入口注册到会话标题栏并清理样式副作用', async () => {
  const buildScript = await fs.readFile(new URL('scripts/build-client.js', root), 'utf8')
  const builtClient = await fs.readFile(new URL('src/plugin/client.js', root), 'utf8')

  for (const source of [buildScript, builtClient]) {
    assert.match(source, /conversation\.session\.header\.actions/)
    assert.doesNotMatch(source, /ctx\.slots\.inject\(['"]settings\.action/)
    assert.match(source, /ctx\.effect/)
    assert.match(source, /style\.remove/)
  }
})

test('客户端 manifest 显式加载会话标题栏 slot 的所属包', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('package.json', root), 'utf8'))
  const dependency = '@deepseek-ai/dsh-client-ui-conversation'

  assert.ok(packageJson.dsh.client.inject.includes(dependency))
  assert.equal(packageJson.peerDependencies[dependency], '^0.1.0-rc.6')
  assert.equal(packageJson.peerDependenciesMeta[dependency].optional, true)
  assert.equal(packageJson.devDependencies[dependency], '^0.1.0-rc.6')
})
