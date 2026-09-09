import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { RpcId, type ClientRequest } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import {
  API_PATH,
  apply,
  inject,
  type ConnectionRequestAuthorizer,
  type HostConnectionHandle,
} from '../src/index.ts'

type Authorize = ConnectionRequestAuthorizer['authorize']

function fakeWebServer(routes: WebRoute[]): Pick<WebServer, 'register' | 'port'> {
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    port: 0,
  }
}

function fakeRequest(
  headers: Record<string, string>,
  url: string,
  body?: unknown,
  peerAddress = '127.0.0.1',
  method = body === undefined ? 'GET' : 'POST',
): IncomingMessage {
  const request = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as IncomingMessage
  Object.assign(request, {
    url,
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: peerAddress },
  })
  return request
}

function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: string } } {
  const state: { status?: number; body?: string } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number) { state.status = value; return this },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: string | Uint8Array) {
      if (value !== undefined) chunks.push(Buffer.from(value))
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

async function mount(authorize: Authorize): Promise<{
  ctx: Context
  routes: WebRoute[]
  connection: HostConnectionHandle
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  ctx.provide('webServer', fakeWebServer(routes) as WebServer)
  ctx.provide('connectionRequestAuthorizer', { authorize })
  const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
  await fiber.await()
  return {
    ctx,
    routes,
    connection: ctx.get('connection') as HostConnectionHandle,
    dispose: () => fiber.dispose(),
  }
}

const allowed = {
  allowed: true as const,
  principal: { provider: 'test', subject: 'alice@example.com' },
}

function rpc(method: string): ClientRequest {
  return { type: 'client-request', rpcId: RpcId('probe'), method, payload: { args: [] } }
}

describe('alpha2 Host Connection compatibility', () => {
  it('requires the external authorizer and exposes the full alpha2 Connection surface', async () => {
    expect(inject).toContain('connectionRequestAuthorizer')
    const mounted = await mount(() => allowed)
    expect(mounted.routes).toHaveLength(1)
    expect(mounted.routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })
    expect(mounted.connection.fetch.register).toBeTypeOf('function')
    expect(mounted.connection.rpc.intercept).toBeTypeOf('function')
    expect(mounted.connection.requestRejection).toBeTypeOf('function')
    expect(mounted.connection.authorizeIndex).toBeTypeOf('function')
    expect(mounted.connection.authenticatedUrl('https://harness.example')).toBe('https://harness.example')
    await mounted.dispose()
    expect(mounted.routes).toHaveLength(0)
  })

  it('keeps real loopback requests local and rejects a spoofed loopback Host', async () => {
    const authorize = vi.fn<Authorize>(() => ({ allowed: false, status: 401 }))
    const mounted = await mount(authorize)
    const local = fakeResponse()
    await mounted.routes[0]!.handler(
      fakeRequest({ host: '127.0.0.1:3080' }, `${API_PATH}/session/list`),
      local.response,
    )
    expect(local.state.status).toBe(404)
    expect(authorize).not.toHaveBeenCalled()

    const spoofed = fakeResponse()
    await mounted.routes[0]!.handler(
      fakeRequest({ host: '127.0.0.1:3080' }, `${API_PATH}/session/list`, undefined, '192.0.2.4'),
      spoofed.response,
    )
    expect(spoofed.state).toEqual({ status: 401, body: 'unauthorized' })
    expect(authorize).toHaveBeenCalledOnce()
    await mounted.dispose()
  })

  it('marks settings as admin authority and ordinary session RPC as use authority', async () => {
    const authorize = vi.fn<Authorize>(() => allowed)
    const mounted = await mount(authorize)
    const unregister = mounted.connection.rpc.intercept('/api', () => true, async () => ({
      ok: true,
      value: {},
    }))

    for (const endpoint of ['settings/describe', 'session/list']) {
      const result = fakeResponse()
      await mounted.routes[0]!.handler(
        fakeRequest(
          { host: 'harness.example', origin: 'http://harness.example' },
          `${API_PATH}/${endpoint}`,
          rpc(endpoint),
          '192.0.2.4',
        ),
        result.response,
      )
      expect(result.state.status).toBe(200)
    }
    expect(authorize.mock.calls[0]![0]).toMatchObject({
      endpoint: 'settings/describe',
      requiredAuthority: 'loopback',
    })
    expect(authorize.mock.calls[1]![0]).toMatchObject({
      endpoint: 'session/list',
      requiredAuthority: 'trusted-host',
    })
    await unregister()
    await mounted.dispose()
  })

  it('supports alpha2 exact Fetch routes such as session export', async () => {
    const mounted = await mount(() => allowed)
    const unregister = mounted.connection.fetch.register({
      path: '/api/session.export',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => new Response('zip', { status: 200 }),
    })
    const result = fakeResponse()
    await mounted.routes[0]!.handler(
      fakeRequest(
        { host: 'harness.example', origin: 'http://harness.example' },
        '/api/session.export',
        undefined,
        '192.0.2.4',
      ),
      result.response,
    )
    expect(result.state).toEqual({ status: 200, body: 'zip' })
    await unregister()
    await mounted.dispose()
  })

  it('applies the same use-authority decision to alpha2 WebSocket and index entry points', async () => {
    const authorize = vi.fn<Authorize>(() => ({ allowed: false, status: 403 }))
    const mounted = await mount(authorize)
    const request = fakeRequest(
      { host: 'harness.example', origin: 'http://harness.example' },
      '/api/remote.mux',
      undefined,
      '192.0.2.4',
    )
    expect(mounted.connection.requestRejection(request)).toBe(403)
    const index = fakeResponse()
    expect(mounted.connection.authorizeIndex(request, index.response)).toBe(false)
    expect(index.state).toEqual({ status: 403, body: 'forbidden' })
    expect(authorize.mock.calls[0]![0]).toMatchObject({
      transport: 'websocket',
      channel: '/api/remote.mux',
      requiredAuthority: 'trusted-host',
    })
    await mounted.dispose()
  })

  it('fails loud on malformed trusted authorities and undersized image envelopes', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeWebServer(routes) as WebServer)
    ctx.provide('connectionRequestAuthorizer', { authorize: () => allowed })
    expect(() => apply(ctx, { trustedHosts: ['harness.example/path'] }))
      .toThrow(/not a bare host\[:port\] authority/)

    ctx.provide('attachments', {
      imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
    } as AttachmentStore)
    expect(() => apply(ctx, { maxRequestBodyBytes: 1024 }))
      .toThrow(/must be at least .* aggregate image limit/)
  })
})
