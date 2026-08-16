# Auth-capable dsh connection implementation

## Goal

Replace the built-in DeepSeek Harness web connection with an rc.6-compatible
dual-face package that requires a request authorizer before exposing remote
HTTP or WebSocket access.

## Confirmed test seams

- `ConnectionRequestAuthorizer.authorize` decisions.
- The Connection HTTP and WebSocket ingress behavior.
- The dsh profile bundle composition that disables the built-in row and mounts
  the replacement.

## Tasks

- [x] Create the private GitHub repository and pin upstream provenance.
- [x] Add the request-authorizer Interface and fail-closed injection.
- [x] Apply one authorization path to shared RPC, dedicated RPC, and WebSocket.
- [x] Rebuild the official browser bundle under the replacement package id.
- [x] Validate package build and profile composition with the Tailscale Adapter.
- [x] Commit, push, and verify the remote repository.
