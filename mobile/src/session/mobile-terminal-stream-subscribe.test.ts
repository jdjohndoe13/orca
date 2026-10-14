import { describe, expect, it, vi } from 'vitest'
import { subscribeMobileTerminalSafely } from './mobile-terminal-stream-subscribe'

describe('subscribeMobileTerminalSafely', () => {
  it('opens the local terminal stream when the row is not mirrored', () => {
    const subscribe = vi.fn(() => () => {})

    subscribeMobileTerminalSafely({ subscribe }, { terminal: 'terminal-1' }, vi.fn(), vi.fn())

    expect(subscribe).toHaveBeenCalledWith(
      'terminal.subscribe',
      { terminal: 'terminal-1' },
      expect.anything()
    )
  })

  it('wraps the terminal subscribe in the gateway bridge for a mirrored row', () => {
    const subscribe = vi.fn(() => () => {})
    const params = { terminal: 'terminal-1', viewport: { cols: 45, rows: 20 } }

    subscribeMobileTerminalSafely({ subscribe }, params, vi.fn(), vi.fn(), {
      mode: 'relay',
      gatewayEnvironmentId: 'env-1'
    })

    expect(subscribe).toHaveBeenCalledWith(
      'runtimeEnvironment.downstream.subscribe',
      { gatewayEnvironmentId: 'env-1', method: 'terminal.subscribe', params },
      expect.anything()
    )
  })

  it('keeps the local path for a pending stamp', () => {
    const subscribe = vi.fn(() => () => {})

    subscribeMobileTerminalSafely({ subscribe }, { terminal: 'terminal-1' }, vi.fn(), vi.fn(), {
      mode: 'pending'
    })

    expect(subscribe).toHaveBeenCalledWith(
      'terminal.subscribe',
      { terminal: 'terminal-1' },
      expect.anything()
    )
  })

  it('reports a synchronous subscribe failure and returns a safe no-op cleanup', () => {
    const onSynchronousError = vi.fn()
    const subscribe = vi.fn(() => {
      throw new Error('socket closed')
    })

    const unsubscribe = subscribeMobileTerminalSafely(
      { subscribe },
      { terminal: 'terminal-1' },
      vi.fn(),
      onSynchronousError
    )

    expect(onSynchronousError).toHaveBeenCalledOnce()
    expect(unsubscribe).not.toThrow()
  })

  it('reports a synchronous bridge failure the same way', () => {
    const onSynchronousError = vi.fn()
    const subscribe = vi.fn(() => {
      throw new Error('socket closed')
    })

    const unsubscribe = subscribeMobileTerminalSafely(
      { subscribe },
      { terminal: 'terminal-1' },
      vi.fn(),
      onSynchronousError,
      { mode: 'relay', gatewayEnvironmentId: 'env-1' }
    )

    expect(onSynchronousError).toHaveBeenCalledOnce()
    expect(unsubscribe).not.toThrow()
  })
})
