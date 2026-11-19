import {
  RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_UNSUBSCRIBE_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_METHOD
} from '../../../../shared/rpc-contract/runtime-environment-relay-params'
import { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-operations'
import { RuntimeEnvironmentStoreError } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import { InvalidArgumentError, type RpcContext } from '../core'

/** The mobile-allowed vehicle names, exported for the fence's own test pin. */
export const MOBILE_RELAY_VEHICLE_METHODS = new Set([
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD,
  RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_UNSUBSCRIBE_METHOD
])

// The four names above are string literals at dispatch time; the type pins
// assertRelayScopeClient to exactly the gateway surface.
export type RuntimeEnvironmentGatewayVehicleMethod =
  | typeof RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_LIST_METHOD
  | typeof RUNTIME_ENVIRONMENT_RELAY_METHOD
  | typeof RUNTIME_ENVIRONMENT_RELAY_ATTACH_SUBSCRIBE_METHOD
  | typeof RUNTIME_ENVIRONMENT_RELAY_DOWNSTREAM_UNSUBSCRIBE_METHOD

export function assertRelayScopeClient(
  ctx: RpcContext,
  method: RuntimeEnvironmentGatewayVehicleMethod
): void {
  // Why a second fence: the websocket gate refuses non-allowlisted methods for
  // mobile scopes ahead of dispatch, so this only fires for transports that skip
  // that gate — same pattern as the paired-only write refusals.
  if (ctx.clientKind !== 'mobile') {
    return
  }
  // Mobile relay reads/attach are allowlist-fenced before dispatch and their
  // forwarded methods are re-fenced at the forwardable sets; these four
  // vehicles are the whole mobile surface, so every other runtimeEnvironment.*
  // stays runtime-scope only here too.
  if (!MOBILE_RELAY_VEHICLE_METHODS.has(method)) {
    throw Object.assign(new Error('Runtime relay methods are runtime-scope only.'), {
      code: 'forbidden'
    })
  }
}

export type GatewayEnvironmentAddress = { gatewayEnvironmentId: string }

export function resolveGatewayEnvironment(
  userDataPath: string,
  params: GatewayEnvironmentAddress
): ReturnType<typeof resolveEnvironment> {
  let environment: ReturnType<typeof resolveEnvironment>
  try {
    environment = resolveEnvironment(userDataPath, params.gatewayEnvironmentId)
  } catch (error) {
    if (error instanceof RuntimeEnvironmentStoreError) {
      throw new InvalidArgumentError(`Unknown gateway environment: ${params.gatewayEnvironmentId}`)
    }
    throw error
  }
  // A stored relay-view row is an address only in the guest's own store; it can
  // never name an upstream host from the gateway's side of the wire.
  if (environment.gatewayEnvironmentId) {
    throw new InvalidArgumentError(`Unknown gateway environment: ${params.gatewayEnvironmentId}`)
  }
  return environment
}
