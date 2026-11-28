import { describe, expect, it, vi } from 'vitest'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { RuntimeRpcCallError } from '../../../../runtime/rpc/calls/runtime-rpc-result'
import { notifyRuntimeScopeForbiddenIfNeeded } from './runtime-scope-forbidden-toast'

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
  it('shows the mobile-scope copy for a code-forbidden error', () => {
    toastError.mockClear()
    const error = forbiddenCallError(MOBILE_SCOPE_MESSAGE)

    expect(notifyRuntimeScopeForbiddenIfNeeded(error)).toBe(true)
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError.mock.calls[0]![0]).toBe('This connection has limited (mobile) access')
    expect(toastError.mock.calls[0]![1]).toEqual({
      id: 'runtime-scope-forbidden',
      description: expect.stringContaining('mobile-scope pairing')
    })
  })

  it('ignores non-forbidden errors', () => {
    toastError.mockClear()
    expect(notifyRuntimeScopeForbiddenIfNeeded(new Error('repo.list failed'))).toBe(false)
    expect(toastError).not.toHaveBeenCalled()
  })
})
