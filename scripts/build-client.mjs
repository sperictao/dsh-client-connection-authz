import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const upstreamPackage = require('@deepseek-ai/dsh-client-connection/package.json')

if (upstreamPackage.version !== '0.1.0-rc.6') {
  throw new Error(
    `unsupported @deepseek-ai/dsh-client-connection version ${String(upstreamPackage.version)}`,
  )
}

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
