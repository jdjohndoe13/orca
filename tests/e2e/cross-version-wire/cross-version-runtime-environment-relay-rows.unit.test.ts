import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkouts/release-checkout'

/**
 * The store format this feature widened: relay view rows carry an optional
 * `gatewayEnvironmentId` marker and never introduce a new `source` arm (the
 * openEnum widening is what degrades future vocabulary instead). A build from
 * before the relay — today's deployed baseline — must load such a store: users
 * downgrade, and a host's environment store is written by its newest build.
 */
test('a pre-relay build still loads an environment store carrying relay downstream rows', async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  // The store's read path is the sync operations core; the public
  // runtime-environment-store.ts is a worker-client wrapper that returns promises
  // and cannot run in the test process. The old build's worker and CLI inline path
  // both run these same functions, so this is what a downgraded build reads with.
  const oldStore = await importReleaseCheckoutModule(
    checkout,
    'src/shared/remote-runtime/host-store/runtime-environment-store-operations.ts'
  )
  // The old build's sources are not part of this bundle: the boundary is
  // inherently untyped.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: listEnvironments is imported from a release checkout of an older build; no shared type exists to typecheck against.
  const listEnvironments = oldStore.listEnvironments as (
    userDataPath: string
  ) => { id: string; name: string }[]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveEnvironment is imported from a release checkout of an older build; no shared type exists to typecheck against.
  const resolveEnvironment = oldStore.resolveEnvironment as (
    userDataPath: string,
    selector: string
  ) => { id: string; name: string }
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-rows-downgrade-'))

  try {
    writeFileSync(
      join(userDataPath, 'orca-environments.json'),
      JSON.stringify({
        version: 1,
        environments: [
          {
            id: 'env-gateway',
            name: 'gateway box',
            createdAt: 1_000,
            updatedAt: 1_000,
            lastUsedAt: null,
            runtimeId: null,
            endpoints: [
              {
                id: 'ws-env-gateway',
                kind: 'websocket',
                label: 'WebSocket',
                endpoint: 'ws://10.0.0.1:6768',
                deviceToken: 'device-token',
                publicKeyB64: 'A'.repeat(43)
              }
            ],
            preferredEndpointId: 'ws-env-gateway'
          },
          {
            id: 'relay-env-web',
            name: 'gateway box → web box',
            createdAt: 2_000,
            updatedAt: 2_000,
            lastUsedAt: null,
            runtimeId: null,
            // Relay marker, source intentionally unset (dump-compatible: no new
            // arm value an old build would need to parse).
            gatewayEnvironmentId: 'env-web',
            endpoints: [
              {
                id: 'ws-relay-env-web',
                kind: 'websocket',
                label: 'WebSocket',
                endpoint: 'ws://10.0.0.1:6768',
                deviceToken: 'device-token',
                publicKeyB64: 'A'.repeat(43)
              }
            ],
            preferredEndpointId: 'ws-relay-env-web'
          }
        ]
      })
    )

    const rows = listEnvironments(userDataPath)
    expect(rows.map((row) => row.name).sort()).toEqual(['gateway box', 'gateway box → web box'])
    expect(resolveEnvironment(userDataPath, 'relay-env-web').name).toContain('web box')
  } finally {
    rmSync(userDataPath, { recursive: true, force: true })
  }
})

let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
})
