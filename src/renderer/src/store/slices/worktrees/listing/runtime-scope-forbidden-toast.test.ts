import { describe, expect, it, vi } from 'vitest'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { runtimeEnvironmentRelayPhase1AllowlistMessage } from '../../../../../../shared/rpc-contract/runtime-environment-relay-params'
import { RuntimeRpcCallError } from '../../../../runtime/rpc/calls/runtime-rpc-result'
import {
  notifyRuntimeScopeForbiddenIfNeeded,
  notifyRuntimeRelayForbiddenMessage,
  isRemoteRuntimeRelayForbiddenError
} from './runtime-scope-forbidden-toast'

function forbiddenCallError(message: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'worktree.detectedList',
    ok: false,
    error: { code: 'forbidden', message },
    _meta: { runtimeId: null }
  })
}

const MOBILE_SCOPE_MESSAGE = 'Runtime relay methods are runtime-scope only.'

describe('runtime-scope forbidden toast', () => {
  it('shows the relay copy for a relay-refused action, not the mobile-scope copy', () => {
    toastError.mockClear()
    const error = forbiddenCallError(
      runtimeEnvironmentRelayPhase1AllowlistMessage('worktree.detectedList')
    )

    expect(notifyRuntimeScopeForbiddenIfNeeded(error)).toBe(true)
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError.mock.calls[0]![0]).toBe(
      "That action isn't available on a view-only relay connection yet."
    )
    expect(toastError.mock.calls[0]![1]).toEqual({ id: 'runtime-scope-forbidden' })
  })

  it('falls back to the mobile-scope copy when the message lacks the shared refusal prefix', () => {
    toastError.mockClear()
    const error = forbiddenCallError(`Runtime relay couldn't forward worktree.list. Try again.`)

    expect(notifyRuntimeScopeForbiddenIfNeeded(error)).toBe(true)
    expect(toastError.mock.calls[0]![0]).toBe('This connection has limited (mobile) access')
    expect(toastError.mock.calls[0]![1]).toEqual({
      id: 'runtime-scope-forbidden',
      description: expect.stringContaining('mobile-scope pairing')
    })
  })

  it('keeps the mobile-scope branch for code-forbidden errors without relay wording', () => {
    expect(isRemoteRuntimeRelayForbiddenError(forbiddenCallError(MOBILE_SCOPE_MESSAGE))).toBe(false)
    expect(isRemoteRuntimeRelayForbiddenError(new Error(MOBILE_SCOPE_MESSAGE))).toBe(false)

    toastError.mockClear()
    expect(notifyRuntimeScopeForbiddenIfNeeded(new Error('repo.list failed'))).toBe(false)
    expect(toastError).not.toHaveBeenCalled()
  })

  describe('row-activation terminal create refusals', () => {
    it('prettifies a rejected terminal create to one friendly toast and no raw one', () => {
      toastError.mockClear()
      // Phase 2 forwards createTerminal, so the still-refused sample is a method
      // the relay off-list canonically refuses.
      const refusal = runtimeEnvironmentRelayPhase1AllowlistMessage('browser.open')

      expect(notifyRuntimeRelayForbiddenMessage(refusal)).toBe(true)

      // Exactly one toast, the friendly tagline, never the raw allowlist string.
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError.mock.calls[0]![0]).toBe(
        "That action isn't available on a view-only relay connection yet."
      )
      expect(toastError.mock.calls[0]![1]).toEqual({ id: 'runtime-scope-forbidden' })
      expect(toastError.mock.calls[0]![0]).not.toContain('Runtime relay does not forward')
    })

    it("leaves ordinary terminal create failures to the caller's raw toast", () => {
      toastError.mockClear()

      expect(notifyRuntimeRelayForbiddenMessage('The workspace is not connected.')).toBe(false)
      expect(toastError).not.toHaveBeenCalled()
    })
  })
})
