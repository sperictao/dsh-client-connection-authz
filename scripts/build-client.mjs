import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// 上游 dsh-client-connection 在 rc 阶段仍会滚动（rc.6 → rc.8+），版本硬等会让
// 插件拖住整个 profile 的依赖解析；client.js 的唯一契约是它恰好包含一次自身
// 模块 id 字符串（下方 occurrences === 1 校验），版本只用于报错的可见性。
const upstreamClientPath = require.resolve('@deepseek-ai/dsh-client-connection/client')
const upstreamModuleId = 'id: "@deepseek-ai/dsh-client-connection"'
const replacementModuleId = 'id: "@dsh-external/dsh-client-connection-authz"'
const upstreamClient = await readFile(upstreamClientPath, 'utf8')
const occurrences = upstreamClient.split(upstreamModuleId).length - 1

if (occurrences !== 1) {
  throw new Error(
    `expected one upstream client module id, found ${String(occurrences)} in ${upstreamClientPath}`,
  )
}

await mkdir('lib', { recursive: true })
await writeFile('lib/client.js', upstreamClient.replace(upstreamModuleId, replacementModuleId))
