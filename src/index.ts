/** Auth-capable replacement for the DeepSeek Harness Web Connection. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH } from './api-path.ts'
import { assertTrustedAuthority } from './api-request-trust.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { HostConnectionService, endpointFromPath } from './rpc-host.ts'
import { ConnectionRequestGate, denyHttpRequest } from './request-authorizer.ts'

export type {
  ConnectionFetchMethod,
  ConnectionFetchHandler,
  ConnectionFetchRoute,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRequestRejection,
  ConnectionRpcResult,
  ConnectionTrustRequest,
  ClientRequest,
  HostConnectionHandle,
  HostConnectionFetch,
  HostConnectionRpc,
  RpcMessage,
  ServerResponse,
} from '@deepseek-ai/dsh-client-connection'
export { RpcId, transportError } from '@deepseek-ai/dsh-client-connection'
export { HostConnectionService } from './rpc-host.ts'
export type {
  ConnectionAuthorizationDecision,
  ConnectionPrincipal,
  ConnectionRequestAuthorizer,
  ConnectionRequestAuthority,
  ConnectionRequestFacts,
  ConnectionRequestHeaders,
  ConnectionRequestTransport,
} from './request-authorizer.ts'
export { API_PATH } from './api-path.ts'

export const name = 'client-connection'
export const inject = ['webServer', 'connectionRequestAuthorizer']

const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

export interface ConnectionConfig {
  trustedHosts?: string[]
  maxRequestBodyBytes?: number
}

export const Config: z<ConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

const PRIVILEGED_ENDPOINTS = new Set([
  'agentPresets/copy',
  'agentPresets/deletePreset',
  'agentPresets/read',
  'credentials/describe',
  'credentials/set',
  'credentials/unset',
  'directoryPicker/createDirectory',
  'directoryPicker/list',
  'directoryPicker/pick',
  'dynamicCordisRunner/getClientCode',
  'dynamicCordisRunner/inventory',
  'dynamicCordisRunner/invoke',
  'dynamicCordisRunner/reportClientGuardFailure',
  'dynamicCordisRunner/reportRenderFailure',
  'dynamicCordisRunner/resolveInspectQuery',
  'dynamicCordisRunner/resolveRequestRun',
  'dynamicCordisRunner/runHostHalf',
  'dynamicCordisRunner/settleUserRun',
  'dynamicCordisRunner/stopFromPanel',
  'dynamicCordisRunner/syncInspectManifest',
  'dynamicCordisRunner/undefineFromPanel',
  'llm/discoverModels',
  'session/canOpenWorkspacePath',
  'session/openWorkspacePath',
  'settings/canOpenAgentPresetDirectory',
  'settings/describe',
  'settings/mutate',
  'settings/openAgentPresetDirectory',
  'settings/openSettingsDocument',
  'settings/replace',
  'settings/update',
])

export function apply(ctx: Context, config?: ConnectionConfig): void {
  const trustedHosts = config?.trustedHosts ?? []
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  assertImageBodyCapacity(ctx, maxRequestBodyBytes)

  const gate = new ConnectionRequestGate(trustedHosts, ctx.connectionRequestAuthorizer)
  const connection = new HostConnectionService(ctx, gate)
  const fetchHandler = connection.createSharedFetchHandler(API_PATH)
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      const endpoint = endpointFromPath(
        API_PATH,
        new URL(req.url ?? '/', 'http://dsh.internal').pathname,
      )
      const decision = gate.authorize(req, {
        transport: 'http',
        channel: API_PATH,
        ...(endpoint === undefined ? {} : { endpoint }),
        requiredAuthority: endpoint !== undefined && PRIVILEGED_ENDPOINTS.has(endpoint)
          ? 'loopback'
          : 'trusted-host',
      })
      if (!decision.allowed) {
        denyHttpRequest(res, decision)
        return
      }
      await bridge(req, res, fetchHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
  ctx.inject(['attachments'], (attachmentCtx) => {
    assertImageBodyCapacity(attachmentCtx, maxRequestBodyBytes)
  })
}
