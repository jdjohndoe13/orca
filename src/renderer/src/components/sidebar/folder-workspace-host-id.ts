import {
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'

/**
 * Which host section a folder workspace's row belongs to.
 *
 * Single source of truth: header counting, host bucketing and reveal all resolve
 * the host through here. Two resolvers that drift is how folder workspaces went
 * missing from the sidebar in the first place (#15362). Deliberately distinct
 * from the host *filter* resolver, which additionally defers an explicit
 * default-host group owner back to the row's own connectionId — this one must
 * match where the row actually renders.
 */
export function getFolderWorkspaceHostId(
  folderWorkspace: Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>,
  projectGroup: Pick<ProjectGroup, 'connectionId' | 'executionHostId'>,
  defaultHostId: ExecutionHostId
): ExecutionHostId {
  // Explicit host stamp first: a downstream relay row carries `runtime:relay-…`
  // (executionHostId, connectionId null) and must not relabel to the local lane.
  const explicitFolderHostId = normalizeExecutionHostId(folderWorkspace.executionHostId)
  if (explicitFolderHostId) {
    return explicitFolderHostId
  }
  const explicitProjectGroupHostId = normalizeExecutionHostId(projectGroup.executionHostId)
  if (explicitProjectGroupHostId) {
    return explicitProjectGroupHostId
  }
  const connectionId = folderWorkspace.connectionId ?? projectGroup.connectionId
  return connectionId ? toSshExecutionHostId(connectionId) : defaultHostId
}
