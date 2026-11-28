/** IPC for the client-side hub record: the stored links and the rows derived from them. */
import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../../lazy-ipc-handle-group'
import type {
  HubAddResult,
  HubLinkPublic,
  HubRemoveResult
} from '../../../../shared/remote-runtime/hub/hub-link-ipc-types'
import {
  addHubLinkAndSync,
  listHubLinksForIpc,
  removeHubLinkAndRows,
  syncAllHubLinks
} from './runtime-environment-hub-link-handlers'

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required.`)
  }
  return value.trim()
}

export function registerRuntimeEnvironmentHubHandlers(
  getUserDataPath: () => string,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle('runtimeEnvironments:listHubLinks', (): Promise<HubLinkPublic[]> =>
    listHubLinksForIpc(getUserDataPath())
  )
  ipc.handle(
    'runtimeEnvironments:addHubLink',
    (_event, args: { hubUrl?: string; accessKey?: string }): Promise<HubAddResult> =>
      addHubLinkAndSync(getUserDataPath(), {
        hubUrl: requiredString(args?.hubUrl, 'Hub address'),
        accessKey: requiredString(args?.accessKey, 'Hub access key')
      })
  )
  ipc.handle(
    'runtimeEnvironments:removeHubLink',
    async (_event, args: { hubUrl?: string }): Promise<HubRemoveResult> =>
      await removeHubLinkAndRows(getUserDataPath(), requiredString(args?.hubUrl, 'Hub address'))
  )
  ipc.handle('runtimeEnvironments:syncHubLinks', async (): Promise<void> => {
    await syncAllHubLinks(getUserDataPath())
  })
}
