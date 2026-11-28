// The wire shapes of the hub IPC channels, in `shared` so both the preload surface and the main
// handlers can name them without importing across the process boundary.

export type HubLinkPublic = {
  hubUrl: string
  addedAt: number
}

export type HubAddResult =
  | {
      ok: true
      hubUrl: string
      /** Instances the hub listed and Orca saved. */
      instances: number
      /** False when the hub could not be reached: the link is saved, the rows are not there yet. */
      listed: boolean
    }
  | { ok: false; message: string }

export type HubRemoveResult = { removed: number }
