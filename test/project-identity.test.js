import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const PROJECT_NAME = 'dsh-remote-ssh-ops'

test('项目公开身份统一使用 SSH 搜索友好的名称', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('package.json', root), 'utf8'))
  const patchManifest = await fs.readFile(new URL('cordis.patch.yml', root), 'utf8')
  const buildScript = await fs.readFile(new URL('scripts/build-client.js', root), 'utf8')
  const pluginSource = await fs.readFile(new URL('src/plugin/index.js', root), 'utf8')

  assert.equal(packageJson.name, PROJECT_NAME)
  assert.match(patchManifest, /id: remote-ssh-ops/)
  assert.match(patchManifest, new RegExp(`name: ${PROJECT_NAME}`))
  assert.match(buildScript, /id:'dsh-remote-ssh-ops'/)
  assert.match(buildScript, /name:'remote-ssh-ops-client'/)
  assert.match(pluginSource, /export const name = 'remote-ssh-ops'/)
})

test('README 使用新仓库安装，并同时提供 dsh 与 npx 卸载指令', async () => {
  const readme = await fs.readFile(new URL('README.md', root), 'utf8')

  assert.match(readme, /^# dsh-remote-ssh-ops$/m)
  assert.match(readme, /github:weisiren000\/dsh-remote-ssh-ops#v0\.0\.8/)
  assert.match(readme, /dsh plugin --profile web remove dsh-remote-ssh-ops/)
  assert.match(readme, /npx @deepseek-ai\/dsh plugin --profile web remove dsh-remote-ssh-ops/)
  assert.doesNotMatch(readme, /github:weisiren000\/dsh-remote-ops/)
})
