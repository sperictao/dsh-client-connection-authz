import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const packageRoot = new URL('../', import.meta.url)
const bundlePath = new URL('../lib/client.js', import.meta.url)

describe('browser authority bundle', () => {
  it('lets the authenticated Host decide privileged access for remote pages', async () => {
    await execFileAsync(process.execPath, ['scripts/build-client.mjs'], {
      cwd: packageRoot,
    })

    const bundle = await readFile(bundlePath, 'utf8')
    expect(bundle).toContain('id: "@dsh-external/dsh-client-connection-authz"')
    expect(bundle).toContain('isLoopback: true')
    expect(bundle).not.toContain(
      'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)',
    )
  })
})
