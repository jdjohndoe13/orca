import { useAppStore } from '@/store'

// Chromium maps hardware back/forward mouse buttons (XButton1/2) to DOM buttons 3/4.
const MOUSE_BACK_BUTTON = 3
const MOUSE_FORWARD_BUTTON = 4

function onWorktreeHistoryMouseDown(event: MouseEvent): void {
  if (event.button !== MOUSE_BACK_BUTTON && event.button !== MOUSE_FORWARD_BUTTON) {
    return
  }
  // Why sole-bit check: any other bits set in `buttons` mean another press/drag (tab drag, middle-click paste) is still in progress.
  if (event.buttons !== 1 << event.button) {
    return
  }
  // Why no terminal yield: vendored @xterm/xterm's MouseService folds mousedown buttons >=3 to CoreMouseButton.NONE and drops NONE reports before encoding (src/browser/services/MouseService.ts) — a TUI can never see back/forward.
  // Why preventDefault: mark the gesture handled so a browser mouse-back/forward default cannot stack with the store navigation.
  event.preventDefault()
  // Why store actions, not createAppCommandHandlers: its claim() pipeline is keyboard-chord scoped (ShortcutDispatchInput + per-keydown state) and ends in these same actions.
  if (event.button === MOUSE_BACK_BUTTON) {
    useAppStore.getState().goBackWorktree()
  } else {
    useAppStore.getState().goForwardWorktree()
  }
}

export function attachWorktreeHistoryMouseNavigation(): () => void {
  // Why capture: same attach shape as the other document chrome listeners, and survives any element-level stopPropagation.
  document.addEventListener('mousedown', onWorktreeHistoryMouseDown, true)
  return () => {
    document.removeEventListener('mousedown', onWorktreeHistoryMouseDown, true)
  }
}
