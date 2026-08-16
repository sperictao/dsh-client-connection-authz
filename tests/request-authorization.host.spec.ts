import { EventEmitter, once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import {
  API_PATH,
  apply,
  inject,
  MUX_EVENTS_PATH,
  type ConnectionRequestAuthorizer,
  type HostConnectionHandle,
} from '../src/index.ts'

type Authorize = ConnectionRequestAuthorizer['authorize']

function fakeWebServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

function fakeRequest(
  headers: Record<string, string>,
  url: string,
  body?: unknown,
  peerAddress = '127.0.0.1',
): IncomingMessage {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(request, {
    url,
    method: body === undefined ? 'GET' : 'POST',
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

async function mount(authorize: Authorize, withApiProxy = false): Promise<{
  ctx: Context
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  ctx.provide('webServer', fakeWebServer(routes, upgrades) as WebServer)
  ctx.provide('connectionRequestAuthorizer', { authorize })
  if (withApiProxy) ctx.provide('apiProxy', {} as ApiProxy)
  const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
  await fiber.await()
  return { ctx, routes, upgrades, dispose: () => fiber.dispose() }
}

const remotePrincipal = { provider: 'test', subject: 'alice@example.com' }

describe('connection request authorization', () => {
  it('declares the authorizer as a required provider', () => {
    expect(inject).toContain('connectionRequestAuthorizer')
  })

  it('keeps valid loopback same-origin access local and bypasses the remote authorizer', async () => {
    const authorize = vi.fn<Authorize>(() => ({ allowed: false, status: 401 }))
    const { routes, dispose } = await mount(authorize)
    const result = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({ host: '127.0.0.1:3080' }, `${API_PATH}/session.list`),
      result.response,
    )
    expect(result.state.status).toBe(404)
    expect(authorize).not.toHaveBeenCalled()
    await dispose()
  })

  it('does not treat a spoofed loopback Host from a remote peer as local', async () => {
    const authorize = vi.fn<Authorize>(() => ({ allowed: false, status: 401 }))
    const { routes, dispose } = await mount(authorize)
    const result = fakeResponse()
    await routes[0]!.handler(
      fakeRequest(
        { host: '127.0.0.1:3080' },
        `${API_PATH}/session.list`,
        undefined,
        '192.0.2.44',
      ),
      result.response,
    )
    expect(result.state).toEqual({ status: 401, body: 'unauthorized' })
    expect(authorize).toHaveBeenCalledOnce()
    await dispose()
  })

  it('authorizes a declared remote Host before ordinary HTTP dispatch', async () => {
    const authorize = vi.fn<Authorize>(() => ({ allowed: false, status: 401 }))
    const { routes, dispose } = await mount(authorize)
    const denied = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({ host: 'harness.example' }, `${API_PATH}/session.list`),
      denied.response,
    )
    expect(denied.state).toEqual({ status: 401, body: 'unauthorized' })
    expect(authorize).toHaveBeenCalledOnce()
    expect(authorize.mock.calls[0]![0]).toMatchObject({
      transport: 'http',
      channel: API_PATH,
      endpoint: 'session.list',
      requiredAuthority: 'trusted-host',
    })
    expect(authorize.mock.calls[0]![0].headers.get('host')).toBe('harness.example')
    await dispose()
  })

  it('lets the plugin explicitly grant a remote caller loopback authority', async () => {
    const authorize = vi.fn<Authorize>(() => ({ allowed: true, principal: remotePrincipal }))
    const { routes, dispose } = await mount(authorize)
    const result = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({ host: 'harness.example' }, `${API_PATH}/settings.describe`),
      result.response,
    )
    expect(result.state.status).toBe(404)
    expect(authorize.mock.calls[0]![0]).toMatchObject({
      channel: API_PATH,
      endpoint: 'settings.describe',
      requiredAuthority: 'loopback',
    })
    await dispose()
  })

  it('authorizes WebSocket upgrades through the same interface before negotiation', async () => {
    const authorize = vi.fn<Authorize>(() => ({ allowed: false, status: 401 }))
    const { upgrades, dispose } = await mount(authorize, true)
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await upgrades[0]!.handler(
      fakeRequest({ host: 'harness.example' }, MUX_EVENTS_PATH),
      socket,
      Buffer.alloc(0),
    )
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 401 Unauthorized')
    expect(authorize.mock.calls[0]![0]).toMatchObject({
      transport: 'websocket',
      channel: API_PATH,
      endpoint: MUX_EVENTS_PATH.slice(`${API_PATH}/`.length),
      requiredAuthority: 'trusted-host',
    })
    await dispose()
  })

  it('authorizes a dedicated RPC channel before reading or dispatching its body', async () => {
    const authorize = vi.fn<Authorize>(() => ({ allowed: false, status: 403 }))
    const { ctx, routes, dispose } = await mount(authorize)
    const connection = ctx.get('connection') as HostConnectionHandle
    const handler = vi.fn(async () => ({ ok: true as const, value: null }))
    connection.rpc.handle('/rpc', handler, { authority: 'trusted-host' })
    const route = routes.find(candidate => candidate.path === '/rpc')!
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-denied'),
      method: 'goals/create',
      payload: {},
    }
    const result = fakeResponse()
    await route.handler(
      fakeRequest({ host: 'harness.example' }, '/rpc/goals/create', request),
      result.response,
    )
    expect(result.state).toEqual({ status: 403, body: 'forbidden' })
    expect(handler).not.toHaveBeenCalled()
    expect(authorize.mock.calls[0]![0]).toMatchObject({
      transport: 'http',
      channel: '/rpc',
      endpoint: 'goals/create',
      requiredAuthority: 'trusted-host',
    })
    await dispose()
  })

  it('resolves a shared interceptor authority before authorization and dispatch', async () => {
    const authorize = vi.fn<Authorize>(() => ({ allowed: true, principal: remotePrincipal }))
    const { ctx, routes, dispose } = await mount(authorize)
    const connection = ctx.get('connection') as HostConnectionHandle
    const handler = vi.fn(async () => ({ ok: true as const, value: null }))
    connection.rpc.intercept('/api', endpoint => endpoint === 'goals/create', handler, {
      authority: 'loopback',
    })
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('shared-admin'),
      method: 'goals/create',
      payload: {},
    }
    const result = fakeResponse()
    await routes[0]!.handler(
      fakeRequest({ host: 'harness.example' }, '/api/goals/create', request),
      result.response,
    )
    expect(result.state.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
    expect(authorize.mock.calls[0]![0]).toMatchObject({
      channel: API_PATH,
      endpoint: 'goals/create',
      requiredAuthority: 'loopback',
    })
    await dispose()
  })
})
