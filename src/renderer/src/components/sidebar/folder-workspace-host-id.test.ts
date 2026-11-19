import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { getFolderWorkspaceHostId } from '../../../../shared/sidebar-list/hosts/folder-workspace-host-id'

const LOCAL: ExecutionHostId = 'local'

describe('getFolderWorkspaceHostId', () => {
  it('keeps a local folder workspace on the default host', () => {
    expect(
      getFolderWorkspaceHostId(
        { connectionId: null, executionHostId: null },
        { connectionId: null, executionHostId: null },
        LOCAL
      )
    ).toBe(LOCAL)
  })

  it('resolves the legacy ssh owner before the default host', () => {
    expect(
      getFolderWorkspaceHostId(
        { connectionId: 'target-1', executionHostId: null },
        { connectionId: null, executionHostId: null },
        LOCAL
      )
    ).toBe('ssh:target-1')
    expect(
      getFolderWorkspaceHostId(
        { connectionId: null, executionHostId: null },
        { connectionId: 'target-2', executionHostId: null },
        LOCAL
      )
    ).toBe('ssh:target-2')
  })

  it('honours the folder workspace executionHostId first', () => {
    expect(
      getFolderWorkspaceHostId(
        { connectionId: null, executionHostId: 'runtime:env-a' },
        { connectionId: 'target-1', executionHostId: null },
        LOCAL
      )
    ).toBe('runtime:env-a')
    expect(
      getFolderWorkspaceHostId(
        { connectionId: null, executionHostId: null },
        { connectionId: 'target-1', executionHostId: 'runtime:env-b' },
        LOCAL
      )
    ).toBe('runtime:env-b')
  })

  it('buckets a downstream relay row under its runtime host, not the local one', () => {
    const relayEnvironmentId = 'relay-2559ab63-00e6-423e-9a27-1d7c3f9b1a55'
    const relayHostId = toRuntimeExecutionHostId(relayEnvironmentId)
    // Downstream folder-workspace rows ship executionHostId=`runtime:<envId>`
    // with a null connectionId; the host would otherwise read as local.
    expect(parseExecutionHostId(relayHostId)).toEqual({
      kind: 'runtime',
      id: relayHostId,
      environmentId: relayEnvironmentId
    })
    expect(
      getFolderWorkspaceHostId(
        { connectionId: null, executionHostId: relayHostId },
        { connectionId: null, executionHostId: null },
        LOCAL
      )
    ).toBe(relayHostId)
    // Same verdict for a relay segment carried by the project group alone.
    expect(
      getFolderWorkspaceHostId(
        { connectionId: null, executionHostId: null },
        { connectionId: null, executionHostId: relayHostId },
        LOCAL
      )
    ).toBe(relayHostId)
  })
})
