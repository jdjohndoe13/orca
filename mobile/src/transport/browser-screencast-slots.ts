import {
  decodeBrowserScreencastFrame,
  type BrowserScreencastFrame
} from '../browser/screencast/browser-screencast-protocol'

export type BrowserScreencastTarget = {
  method: string
  cancelled?: boolean
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
}

/**
 * Slot bookkeeping for the single browser screencast the phone may stream at a
 * time: the newest subscribe owns the slot, and a ready reply only counts when
 * it names the pending or active request.
 */
export class BrowserScreencastSlots {
  private activeId: string | null = null
  private pendingId: string | null = null

  /** Track a new subscribe; returns older request ids the caller must dispose. */
  claim(id: string): string[] {
    const stale = [this.activeId, this.pendingId].filter(
      (other): other is string => other !== null && other !== id
    )
    this.pendingId = id
    this.activeId = null
    return stale
  }

  /** Queue the pending request for a post-authentication replay. */
  queueForReplay(id: string): void {
    this.pendingId = id
    this.activeId = null
  }

  /** Reconnect clears both slots; the host lost every registration anyway. */
  reset(): void {
    this.activeId = null
    this.pendingId = null
  }

  /** A ready reply for an id that no longer owns a slot is stale: the caller must unsubscribe it. */
  acceptReady(id: string): boolean {
    if (this.pendingId !== id && this.activeId !== id) {
      return false
    }
    this.pendingId = null
    this.activeId = id
    return true
  }

  get active(): string | null {
    return this.activeId
  }

  release(id: string): void {
    if (this.activeId === id) {
      this.activeId = null
    }
    if (this.pendingId === id) {
      this.pendingId = null
    }
  }
}

/** Decode raw bytes into a screencast frame, or null when they are not one. */
export function decodeBrowserScreencast(bytes: Uint8Array): BrowserScreencastFrame | null {
  return decodeBrowserScreencastFrame(bytes)
}

/** Deliver a decoded frame to the active stream only; a swapped-out stream never sees it. */
export function routeBrowserScreencastFrame(
  activeStream: BrowserScreencastTarget | undefined,
  frame: BrowserScreencastFrame
): void {
  if (!activeStream || activeStream.cancelled || activeStream.method !== 'browser.screencast') {
    return
  }
  activeStream.onBinaryFrame?.(frame)
}
