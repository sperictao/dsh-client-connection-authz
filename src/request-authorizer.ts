import type { IncomingHttpHeaders } from 'node:http'
import type { ServerResponse } from 'node:http'
import { isTrustedApiRequest } from './api-request-trust.ts'
import { isLoopbackHostname } from './loopback-hostname.ts'

/** Request transports guarded by the replacement Connection package. */
export type ConnectionRequestTransport = 'http' | 'websocket'

/** Authority tier requested by the selected Connection endpoint. */
export type ConnectionRequestAuthority = 'trusted-host' | 'loopback'

/** Read-only header view exposed to authentication plugins. */
export interface ConnectionRequestHeaders {
  /** Return one wire header, case-insensitively, or undefined when absent/ambiguous. */
  get(name: string): string | undefined
}

/** Transport facts supplied to the authentication plugin. */
export interface ConnectionRequestFacts {
  readonly transport: ConnectionRequestTransport
  readonly channel: string
  readonly endpoint?: string
  readonly requiredAuthority: ConnectionRequestAuthority
  readonly headers: ConnectionRequestHeaders
  readonly peerAddress?: string
}

/** Authenticated caller identity reported by an authorizer. */
export interface ConnectionPrincipal {
  readonly provider: string
  readonly subject: string
  readonly displayName?: string
  readonly capabilities?: readonly string[]
}

/** Fail-closed decision returned synchronously at the HTTP upgrade boundary. */
export type ConnectionAuthorizationDecision =
  | { readonly allowed: true; readonly principal: ConnectionPrincipal }
  | { readonly allowed: false; readonly status: 401 | 403 }

/** Plugin-owned authorization seam consumed by the replacement Connection package. */
export interface ConnectionRequestAuthorizer {
  authorize(facts: ConnectionRequestFacts): ConnectionAuthorizationDecision
}

interface RequestWithHeaders {
  readonly headers: IncomingHttpHeaders | Headers
  readonly socket: { readonly remoteAddress: string | undefined }
}

type ConnectionRequestFactsWithoutHeaders = Omit<ConnectionRequestFacts, 'headers'>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Required request authorizer supplied by a separate authentication plugin. */
    connectionRequestAuthorizer: ConnectionRequestAuthorizer
  }
}

/** Mandatory Host/Origin fence plus local bypass and plugin authorization. */
export class ConnectionRequestGate {
  constructor(
    private readonly trustedHosts: readonly string[],
    private readonly authorizer: ConnectionRequestAuthorizer,
  ) {}

  authorize(
    request: RequestWithHeaders,
    facts: ConnectionRequestFactsWithoutHeaders,
  ): ConnectionAuthorizationDecision {
    if (!isTrustedApiRequest(request, this.trustedHosts)) {
      return { allowed: false, status: 403 }
    }
    const peerAddress = request.socket?.remoteAddress
    if (isTrustedApiRequest(request, []) && isLoopbackPeerAddress(peerAddress)) {
      return {
        allowed: true,
        principal: { provider: 'loopback', subject: 'local' },
      }
    }
    return this.authorizer.authorize({
      ...facts,
      headers: headerView(request.headers),
      ...(peerAddress === undefined ? {} : { peerAddress }),
    })
  }
}

function isLoopbackPeerAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1') return true
  const normalized = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address
  return isLoopbackHostname(normalized)
}

/** Write a fixed response without leaking plugin-specific denial details. */
export function denyHttpRequest(
  response: ServerResponse,
  decision: Extract<ConnectionAuthorizationDecision, { allowed: false }>,
): void {
  response.writeHead(decision.status)
  response.end(decision.status === 401 ? 'unauthorized' : 'forbidden')
}

function headerView(headers: IncomingHttpHeaders | Headers): ConnectionRequestHeaders {
  return {
    get(name) {
      if (headers instanceof Headers) return headers.get(name) ?? undefined
      const value = headers[name.toLowerCase()]
      return typeof value === 'string' ? value : undefined
    },
  }
}
