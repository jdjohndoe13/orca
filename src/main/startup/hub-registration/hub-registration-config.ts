// Where the hub registration settings come from, and whether they are usable.
//
// Two sources, env wins:
//   1. `ORCA_HUB_URL`, `ORCA_HUB_REGISTRATION_SECRET`, `ORCA_HUB_ACCESS_KEY`,
//      `ORCA_HUB_NAME` (optional, defaults to the hostname);
//   2. `orca-hub.json` beside the E2EE keypair in the profile's userData dir —
//      the same directory `orca-e2ee-keypair.json` lives in, so a VM
//      provisioned for one profile picks up both with one file copy.
//
// Registration stays disabled unless a URL, a registration secret and an
// access key are all present. Each is a distinct secret with a distinct job
// (the secret authorizes the claim, the access key scopes who may discover
// the instance), so a half-configured VM must not dial out and leak its
// public key. The URL must be a `ws`/`wss` endpoint: the hub is the listener,
// so a VM that dials anything else is misconfigured.
//
// The file is read with `fs.promises`: the ratchet charges every synchronous
// fs/child_process call in main, and this runs on the serve startup path.

import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { HUB_DEFAULT_REFRESH_MS } from './hub-registration-protocol'

export const HUB_REGISTRATION_CONFIG_FILENAME = 'orca-hub.json'
export const MAX_HUB_REGISTRATION_CONFIG_BYTES = 8 * 1024
export const HUB_DEFAULT_CAPABILITIES: readonly string[] = ['rpc']
// The hub's schema caps `ports` at 16; the serve WS port is the only one today.
const MAX_REGISTERED_PORTS = 16

export type HubRegistrationConfig = {
  /** The hub's `wss://host:port/v1/register` URL. */
  url: string
  /** Provisioned: authorizes the instanceId claim. */
  registrationSecret: string
  /** Provisioned: hashed into keyMatch per instance; the client presents it. */
  accessKey: string
  /** Label for the client's list. */
  name: string
  /** Loopback ports the sink will dial on Open; the first is the bridge target. */
  ports: number[]
  capabilities: string[]
  /** Re-registration cadence until the hub's `welcome` names one. */
  refreshMs: number
}

export type HubRegistrationConfigResolution =
  | { enabled: true; source: 'env' | 'file'; config: HubRegistrationConfig }
  | { enabled: false; reason: string }

export type HubRegistrationConfigInput = {
  userDataPath: string
  env?: Record<string, string | undefined>
  /** The serve's own actually-bound WS port, registered as the bridge target. */
  servePort: number
  hostName?: string
}

export function hubRegistrationConfigPath(userDataPath: string): string {
  return join(userDataPath, HUB_REGISTRATION_CONFIG_FILENAME)
}

/**
 * The port the serve actually bound, from the endpoint the RPC server
 * publishes after its transport is listening (bracketed for IPv6).
 */
export function serveWsPortFromEndpoint(endpoint: string | null): number | null {
  if (!endpoint) {
    return null
  }
  try {
    const port = Number(new URL(endpoint).port)
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null
  } catch {
    return null
  }
}

/** Resolves the config, or why registration is off. Never throws. */
export async function resolveHubRegistrationConfig(
  input: HubRegistrationConfigInput
): Promise<HubRegistrationConfigResolution> {
  const env = input.env ?? process.env
  const file = await readHubRegistrationConfigFile(input.userDataPath)
  const url = trimmed(env.ORCA_HUB_URL) ?? trimmed(recordString(file, 'url'))
  const registrationSecret =
    trimmed(env.ORCA_HUB_REGISTRATION_SECRET) ?? trimmed(recordString(file, 'registrationSecret'))
  const accessKey = trimmed(env.ORCA_HUB_ACCESS_KEY) ?? trimmed(recordString(file, 'accessKey'))
  if (!url) {
    return { enabled: false, reason: 'hub_url_missing' }
  }
  if (!isHubUrl(url)) {
    return { enabled: false, reason: 'hub_url_invalid' }
  }
  if (!registrationSecret) {
    return { enabled: false, reason: 'registration_secret_missing' }
  }
  if (!accessKey) {
    return { enabled: false, reason: 'access_key_missing' }
  }
  const ports = portList(file?.ports) ?? [input.servePort]
  return {
    enabled: true,
    source: trimmed(env.ORCA_HUB_URL) === undefined ? 'file' : 'env',
    config: {
      url,
      registrationSecret,
      accessKey,
      name:
        trimmed(env.ORCA_HUB_NAME) ??
        trimmed(recordString(file, 'name')) ??
        input.hostName ??
        hostname(),
      ports,
      capabilities: [...(stringList(file?.capabilities) ?? HUB_DEFAULT_CAPABILITIES)],
      refreshMs: positiveInteger(file?.refreshMs) ?? HUB_DEFAULT_REFRESH_MS
    }
  }
}

async function readHubRegistrationConfigFile(
  userDataPath: string
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(hubRegistrationConfigPath(userDataPath))
    if (raw.byteLength > MAX_HUB_REGISTRATION_CONFIG_BYTES) {
      return null
    }
    const value: unknown = JSON.parse(raw.toString('utf8'))
    return typeof value === 'object' && value !== null
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the typeof guard above proves an object; JSON objects are string-keyed.
        (value as Record<string, unknown>)
      : null
  } catch {
    // A missing file is the normal case: every VM that never dials a hub.
    return null
  }
}

function isHubUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'ws:' || protocol === 'wss:'
  } catch {
    return false
  }
}

function recordString(file: Record<string, unknown> | null, key: string): string | undefined {
  const value = file?.[key]
  return typeof value === 'string' ? value : undefined
}

function trimmed(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1000 ? value : undefined
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every((c) => typeof c === 'string')
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the every() guard above proves every element is a string.
      (value as string[])
    : undefined
}

function portList(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REGISTERED_PORTS) {
    return undefined
  }
  return value.every((p) => typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65_535)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the every() guard above proves every element is an integer port.
      (value as number[])
    : undefined
}
