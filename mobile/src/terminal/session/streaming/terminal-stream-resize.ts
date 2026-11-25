import { isTerminalOscLinkRanges } from '../../../../../src/shared/terminal/links/terminal-osc-link-ranges'
import type { TerminalWebViewHandle } from '../../webview/terminal-webview-contract'
import type { TerminalFrame } from '../../webview/terminal-webview-messages'
import type { MobileTerminalDiagnostics } from '../mobile-terminal-diagnostics'
import type {
  MutableRef,
  TerminalViewportDims,
  TerminalViewportResubscribeBudget
} from './mobile-terminal-viewport-resubscribe'
import { updateTerminalCwdFromStreamEvent } from './terminal-stream-cwd'
import type { createTerminalStreamResumeCursor } from './terminal-stream-resume'

/**
 * The stream's `resized` event: width reflow needs a full-buffer reinit; geometry-only events
 * just resize. Extracted from the subscription hook so the listener keeps its shape.
 */
export function applyTerminalStreamResized(
  data: Readonly<Record<string, unknown>>,
  deps: {
    handle: string
    seq: number
    diagnostics: Pick<MobileTerminalDiagnostics, 'streamResized'>
    viewportBudget: TerminalViewportResubscribeBudget
    viewportRef: MutableRef<TerminalViewportDims | null>
    viewportMeasuredRef: MutableRef<boolean>
    terminalFrameRef: MutableRef<TerminalFrame | null>
    terminalCwdRef: MutableRef<Map<string, string>>
    resume: Pick<ReturnType<typeof createTerminalStreamResumeCursor>, 'invalidate'>
    adoptDisplayMode: (displayMode: unknown) => void
    scheduleSettledFit: (terminal: TerminalWebViewHandle | undefined) => void
    getTerminalRef: (handle: string) => TerminalWebViewHandle | undefined
  }
): void {
  const {
    handle,
    seq,
    diagnostics,
    viewportBudget,
    viewportRef,
    viewportMeasuredRef,
    terminalFrameRef,
    terminalCwdRef,
    resume,
    adoptDisplayMode,
    scheduleSettledFit,
    getTerminalRef
  } = deps
  updateTerminalCwdFromStreamEvent(handle, data, terminalCwdRef.current)
  // Width reflow needs full-buffer reinit; geometry-only events just resize.
  const viewport = viewportMeasuredRef.current ? viewportRef.current : null
  const [cols, rows] = viewportBudget.observeResize(handle, data, viewport)
  const serialized = typeof data.serialized === 'string' ? data.serialized : null
  const eventSeq = typeof data.seq === 'number' ? data.seq : null
  diagnostics.streamResized(handle, seq, eventSeq, data, getTerminalRef(handle) != null)
  const oscLinks = isTerminalOscLinkRanges(data.oscLinks) ? data.oscLinks : undefined
  if (serialized != null) {
    resume.invalidate()
    getTerminalRef(handle)?.init({
      cols,
      rows,
      initialData: serialized,
      preserveScroll: true,
      oscLinks,
      kittyFlags: data.kittyKeyboardFlags,
      frame: terminalFrameRef.current
    })
  } else {
    getTerminalRef(handle)?.resize(cols, rows, terminalFrameRef.current)
  }
  adoptDisplayMode(data.displayMode)
  scheduleSettledFit(getTerminalRef(handle))
}
