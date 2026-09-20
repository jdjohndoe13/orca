// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  goBackWorktree: vi.fn(),
  goForwardWorktree: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))

import { attachWorktreeHistoryMouseNavigation } from './worktree-history-mouse-navigation'

let dispose: (() => void) | null = null

function appendChromeTarget(): HTMLElement {
  const target = document.createElement('div')
  document.body.appendChild(target)
  return target
}

function appendXtermTarget(mouseReporting: boolean): HTMLElement {
  const terminal = document.createElement('div')
  // xterm itself toggles `enable-mouse-events` on its root while mouse reporting is active.
  terminal.className = mouseReporting ? 'xterm enable-mouse-events' : 'xterm'
  const target = document.createElement('div')
  terminal.appendChild(target)
  document.body.appendChild(terminal)
  return target
}

function appendXtermHelperTextareaTarget(mouseReporting: boolean): HTMLTextAreaElement {
  // Realistic xterm nesting: the helper textarea lives inside the `.xterm` container.
  const terminal = document.createElement('div')
  terminal.className = mouseReporting ? 'xterm enable-mouse-events' : 'xterm'
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  terminal.appendChild(textarea)
  document.body.appendChild(terminal)
  return textarea
}

function press(target: HTMLElement, button: number, buttons = 1 << button): MouseEvent {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button, buttons })
  target.dispatchEvent(event)
  return event
}

describe('worktree history mouse navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getState.mockReturnValue({
      goBackWorktree: mocks.goBackWorktree,
      goForwardWorktree: mocks.goForwardWorktree
    })
  })

  afterEach(() => {
    dispose?.()
    dispose = null
    document.body.replaceChildren()
  })

  it('maps mouse button 3 (back) to goBackWorktree over chrome', () => {
    dispose = attachWorktreeHistoryMouseNavigation()
    const event = press(appendChromeTarget(), 3)

    expect(mocks.goBackWorktree).toHaveBeenCalledOnce()
    expect(mocks.goForwardWorktree).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('maps mouse button 4 (forward) to goForwardWorktree over chrome', () => {
    dispose = attachWorktreeHistoryMouseNavigation()
    const event = press(appendChromeTarget(), 4)

    expect(mocks.goForwardWorktree).toHaveBeenCalledOnce()
    expect(mocks.goBackWorktree).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('fires from an empty app area with no element target', () => {
    dispose = attachWorktreeHistoryMouseNavigation()

    press(document.body, 4)

    expect(mocks.goForwardWorktree).toHaveBeenCalledOnce()
  })

  it('navigates inside a terminal with no mouse reporting (plain shell)', () => {
    dispose = attachWorktreeHistoryMouseNavigation()

    press(appendXtermTarget(false), 3)
    press(appendXtermHelperTextareaTarget(false), 4)

    expect(mocks.goBackWorktree).toHaveBeenCalledOnce()
    expect(mocks.goForwardWorktree).toHaveBeenCalledOnce()
  })

  it('navigates inside a terminal even while a TUI owns the mouse', () => {
    dispose = attachWorktreeHistoryMouseNavigation()

    press(appendXtermTarget(true), 3)
    press(appendXtermTarget(true), 4)
    press(appendXtermHelperTextareaTarget(true), 3)
    press(appendXtermHelperTextareaTarget(true), 4)

    expect(mocks.goBackWorktree).toHaveBeenCalledTimes(2)
    expect(mocks.goForwardWorktree).toHaveBeenCalledTimes(2)
  })

  it('leaves primary, middle, and right buttons untouched', () => {
    dispose = attachWorktreeHistoryMouseNavigation()
    const target = appendChromeTarget()

    const unhandled = press(target, 2)
    press(target, 0)
    press(target, 1)

    expect(mocks.goBackWorktree).not.toHaveBeenCalled()
    expect(mocks.goForwardWorktree).not.toHaveBeenCalled()
    expect(unhandled.defaultPrevented).toBe(false)
  })

  it('ignores a side button pressed while another button is held', () => {
    dispose = attachWorktreeHistoryMouseNavigation()
    const target = appendChromeTarget()

    // buttons masks: 9 = primary+back, 17 = primary+forward (drag/middle gesture in progress).
    press(target, 3, 9)
    press(target, 4, 17)

    expect(mocks.goBackWorktree).not.toHaveBeenCalled()
    expect(mocks.goForwardWorktree).not.toHaveBeenCalled()
  })

  it('stops triggering after dispose', () => {
    const detach = attachWorktreeHistoryMouseNavigation()
    dispose = detach

    press(appendChromeTarget(), 3)
    detach()
    dispose = null
    press(document.body, 3)

    expect(mocks.goBackWorktree).toHaveBeenCalledOnce()
  })
})
