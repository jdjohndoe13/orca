// Start/stop the hub registration around the serve WS listener.
//
// Registration needs the WS port the serve *actually* bound, which is only
// known once the transport is listening: the serve pins 6768 by default but
// falls back to a ladder and, for E2E, to an OS-assigned port. So the hook runs
// after the RPC server has started and reads the published endpoint, not the
// CLI argument.
//
// It is deliberately best-effort. A VM that cannot reach its hub is a VM that
// is simply not reachable through the hub; it must still serve its local
// clients, so a failure here is logged and never fails startup.
//
// The public key comes from the RPC server when it is loaded (the same key the
// pairing offer advertises) and from the keypair file otherwise. The file is
// read asynchronously: the ratchet charges every synchronous fs call in main.

import { resolveHubRegistrationConfig, serveWsPortFromEndpoint } from './hub-registration-config'
import { readProfileRuntimePublicKeyAsync } from './hub-registration-keypair'
import { registerWithHub, type HubRegistrationHandle } from './hub-registration'

export type HubRegistrationRpcServer = {
  getE2EEPublicKey(): string | null
  getWebSocketEndpoint(): string | null
  /** The profile dir the E2EE keypair — and so `orca-hub.json` — lives in. */
  getPairingUserDataPath(): string
}

export type HubRegistrationStartupOptions = {
  rpc: HubRegistrationRpcServer
  env?: Record<string, string | undefined>
  log?: (message: string) => void
}

/**
 * Dials the hub when this VM is configured for one. Returns the stop handle, or
 * null when registration is off: no config, no bound WS port, or no keypair.
 */
export async function startHubRegistration(
  options: HubRegistrationStartupOptions
): Promise<HubRegistrationHandle | null> {
  const log = options.log ?? defaultLog
  const userDataPath = options.rpc.getPairingUserDataPath()
  const servePort = serveWsPortFromEndpoint(options.rpc.getWebSocketEndpoint())
  if (servePort === null) {
    return null
  }
  const resolution = await resolveHubRegistrationConfig({
    userDataPath,
    ...(options.env ? { env: options.env } : {}),
    servePort
  })
  if (!resolution.enabled) {
    return null
  }
  const publicKeyB64 =
    options.rpc.getE2EEPublicKey() ??
    (await readProfileRuntimePublicKeyAsync(userDataPath))?.toString('base64')
  if (!publicKeyB64) {
    log(`hub registration disabled: no E2EE keypair in ${userDataPath}`)
    return null
  }
  log(`registering with ${resolution.config.url} (from ${resolution.source})`)
  return registerWithHub({ ...resolution.config, publicKeyB64 }, { log })
}

/**
 * Starts the registration and hands back its stop, or null when registration
 * is off. Never rejects: the caller wires this into a serve startup sequence
 * that must not fail over a hub.
 */
export async function startHubRegistrationBestEffort(
  options: HubRegistrationStartupOptions
): Promise<(() => void) | null> {
  const log = options.log ?? defaultLog
  try {
    const handle = await startHubRegistration(options)
    if (!handle) {
      return null
    }
    let stopped = false
    return () => {
      if (stopped) {
        return
      }
      stopped = true
      handle.stop()
    }
  } catch (error) {
    log(`hub registration failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * Starts the registration and registers its own stop. The serve startup
 * sequences use this so the call site stays one line.
 */
export async function installHubRegistration(
  rpc: HubRegistrationRpcServer,
  registerStop: (stop: () => void) => void
): Promise<void> {
  const stop = await startHubRegistrationBestEffort({ rpc })
  if (stop) {
    registerStop(stop)
  }
}

function defaultLog(message: string): void {
  console.warn(`[hub] ${message}`)
}
