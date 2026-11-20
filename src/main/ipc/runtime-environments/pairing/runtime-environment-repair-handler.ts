import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../../lazy-ipc-handle-group'
import type { VerifyAndAddRuntimeEnvironmentResult } from '../../../../shared/remote-runtime/pairing/remote-pairing-verification'
import {
  verifyAndRepairRuntimeEnvironmentFromPairingCode,
  type RepairRuntimeEnvironmentArgs
} from './runtime-environment-pairing-verification'
import { publishVerifiedPairing } from './runtime-environment-verified-pairing-publish'

export function registerRuntimeEnvironmentRepairHandler(
  {
    getUserDataPath,
    invalidateTransport
  }: {
    getUserDataPath: () => string
    invalidateTransport: (environmentId: string) => Promise<void> | void
  },
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle(
    'runtimeEnvironments:repairFromPairingCode',
    async (
      _event,
      args: RepairRuntimeEnvironmentArgs
    ): Promise<VerifyAndAddRuntimeEnvironmentResult> => {
      const result = await verifyAndRepairRuntimeEnvironmentFromPairingCode(getUserDataPath(), args)
      if (result.ok) {
        await publishVerifiedPairing(getUserDataPath(), result, { invalidateTransport })
      }
      return result
    }
  )
}
