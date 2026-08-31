/** Host registry and HTTP adapter for generic Connection RPC channels. */
import { Context, Service } from '@deepseek-ai/cordis'
import {
  clientRequestSchema,
  RpcId,
  type ClientRequest,
  type ConnectionFetchHandler,
  type ConnectionFetchRoute,
  type ConnectionIndexRequest,
  type ConnectionIndexResponse,
  type ConnectionRequestRejection,
  type ConnectionRpcEndpointMatcher,
  type ConnectionRpcFailure,
  type ConnectionRpcHandler,
  type ConnectionRpcResult,
  type ConnectionTrustRequest,
  type HostConnectionFetch,
  type HostConnectionHandle,
  type HostConnectionRpc,
  type RpcId as RpcIdType,
} from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { bridge, type FetchHandler } from './http-bridge.ts'
import { ConnectionRequestGate, denyHttpRequest } from './request-authorizer.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: FetchHandler
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  readonly fetch: ConnectionFetchRoute['fetch']
}

interface ConnectionServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
}

export class HostConnectionService extends Service implements HostConnectionHandle {
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()

  constructor(ctx: Context, private readonly requestGate: ConnectionRequestGate) {
    super(ctx, 'connection')
  }

  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return { register: route => this.registerFetchRoute(owner, route) }
  }

  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    const decision = this.requestGate.authorize(request, {
      transport: 'websocket',
      channel: '/api/remote.mux',
      endpoint: 'remote.mux',
      requiredAuthority: 'trusted-host',
    })
    return decision.allowed ? undefined : decision.status
  }

  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    const decision = this.requestGate.authorize(request, {
      transport: 'http',
      channel: '/',
      requiredAuthority: 'trusted-host',
    })
    if (decision.allowed) return true
    response.writeHead(decision.status)
    response.end(decision.status === 401 ? 'unauthorized' : 'forbidden')
    return false
  }

  authenticatedUrl(baseUrl: string): string {
    return baseUrl
  }

  createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler {
    return {
      fetch: (request) => {
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) return route.fetch(request)
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return interceptor.fetchHandler.fetch(request)
      },
    }
  }

  private registerFetchRoute(owner: Context, route: ConnectionFetchRoute): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    assertChannel(channel)
    const fetchHandler = rpcFetchHandler(channel, handler)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const endpoint = endpointFromPath(
          channel,
          new URL(req.url ?? '/', 'http://dsh.internal').pathname,
        )
        const decision = this.requestGate.authorize(req, {
          transport: 'http',
          channel,
          ...(endpoint === undefined ? {} : { endpoint }),
          requiredAuthority: 'trusted-host',
        })
        if (!decision.allowed) {
          denyHttpRequest(res, decision)
          return
        }
        await bridge(req, res, fetchHandler)
      },
    }
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`,
    )
  }

  private registerInterceptor(
    owner: Context,
    channel: '/api',
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler),
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => { this.interceptors.delete(channel) }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

function rpcFetchHandler(channel: string, handler: ConnectionRpcHandler): FetchHandler {
  return {
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) return invalidEnvelopeResponse(body, envelope.error.issues)
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }
      try {
        return fullResponse(message.rpcId, await handler(endpoint, message.payload, request.signal))
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: readonly object[]): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  return errorResponse(typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

export function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (endpoint.split('/').some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: ConnectionRpcFailure): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: ConnectionRpcResult<unknown>): Response {
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result }
  return Response.json(body)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === API_PATH) {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertFetchRoute(route: ConnectionFetchRoute): void {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  if (new Set(route.methods).size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}
