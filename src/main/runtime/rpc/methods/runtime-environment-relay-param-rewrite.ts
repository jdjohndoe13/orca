import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { relayForbiddenError } from '../../../../shared/rpc-contract/runtime-environment-relay-params'

/**
 * Host-id translation on the gateway, right before a relayed call dials its
 * transport. A guest's renderer embeds its OWN environment id in runtime host
 * ids (`runtime:relay-<gatewayEnvironmentId>`, since hosts downstream learn ids
 * from the census, not from the gateway's store) plus verbatim `local` and
 * `ssh:` ids read off forwarded rows. Three cases per known host field
 * (top-level `hostId` — worktree.rm / worktree.forceDeleteBranch — and
 * `location.executionHostId` inside agentSession.ensure params):
 *
 *   `local` / `ssh:`   kept verbatim, the upstream resolves them itself;
 *   decoded id === the guest's relay row for THIS environment
 *                      top-level hostId is dropped (upstream defaults to its
 *                      own host; location.executionHostId is schema-required
 *                      and rewritten to `local`);
 *   any other runtime id — refused: mutating it would let one relay row operate
 *   a workspace hosted on a neighboring host the call did not address.
 *
 * An unparseable host spelling is refused too: junk must rebind nothing on the
 * upstream. Everything else passes through untouched, shallowly — no walking.
 *
 * Returns the input value itself when nothing needs rewriting; a fresh copy is
 * proof a host id was present (stream-vehicle callers assert on that).
 */
export function rewriteRelayCallParams(
  method: string,
  params: unknown,
  relayRowEnvironmentId: string
): unknown {
  if (!isRecord(params)) {
    return params
  }
  let next = params
  const hostId = params['hostId']
  if (typeof hostId === 'string') {
    const parsed = parseExecutionHostId(hostId)
    if (!parsed) {
      throw relayForbiddenError(method)
    }
    if (parsed.kind === 'runtime') {
      if (parsed.environmentId !== relayRowEnvironmentId) {
        throw relayForbiddenError(method)
      }
      next = { ...params }
      delete next['hostId']
    }
  }
  const location = next['location']
  if (isRecord(location) && typeof location['executionHostId'] === 'string') {
    const parsed = parseExecutionHostId(location['executionHostId'])
    if (!parsed) {
      throw relayForbiddenError(method)
    }
    if (parsed.kind === 'runtime') {
      if (parsed.environmentId !== relayRowEnvironmentId) {
        throw relayForbiddenError(method)
      }
      if (next === params) {
        next = { ...params }
      }
      next['location'] = { ...location, executionHostId: LOCAL_EXECUTION_HOST_ID }
    }
  }
  return next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
