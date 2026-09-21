import { BrowserWindow } from 'electron'
import type { RuntimeWindowBroadcastSurface } from '../runtime/runtime-window-broadcast-surface'

/** The desktop implementation of the runtime's renderer broadcast facility. */
export const electronRuntimeWindowBroadcastSurface: RuntimeWindowBroadcastSurface = {
  broadcast: (channel, payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) {
        continue
      }
      try {
        window.webContents.send(channel, payload)
      } catch {
        // A renderer can disappear between isDestroyed() and send().
      }
    }
  }
}
