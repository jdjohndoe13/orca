import { describe, expect, it } from 'vitest'
import {
  applyDeviceTokenOverride,
  applyEndpointOverride,
  buildOpenAccessPairing,
  isPlaceholderHostKey,
  normalizeOpenAccessEndpoint
} from './open-access-link'
import { DEFAULT_ORCA_ACCESS_KEY } from './open-access'
import { parseHostAccessLink } from '../pairing/remote-pairing-address'
import { encodePairingOffer, parsePairingCode } from '../pairing/pairing'

describe('normalizeOpenAccessEndpoint', () => {
  function endpointOf(input: string): string | null {
    const result = normalizeOpenAccessEndpoint(input)
    return result.ok ? result.value.endpoint : null
  }
  function kindOf(input: string): string | null {
    const result = normalizeOpenAccessEndpoint(input)
    return result.ok ? result.value.endpointKind : null
  }

  it('accepts bare host, host:port, and ws(s) URLs, normalizing to a websocket URL', () => {
    expect(normalizeOpenAccessEndpoint('192.168.250.29:6768')).toEqual({
      ok: true,
      value: {
        endpoint: 'ws://192.168.250.29:6768',
        displayEndpoint: '192.168.250.29:6768',
        endpointKind: 'lan'
      }
    })
    // A bare host without a port gets the runtime default port.
    expect(endpointOf('desk.local')).toBe('ws://desk.local:6768')
    expect(endpointOf('ws://192.168.250.29:6768')).toBe('ws://192.168.250.29:6768')
    expect(endpointOf('wss://relay.example.com:7000')).toBe('wss://relay.example.com:7000')
    expect(endpointOf(' 192.168.250.29:6768 ')).toBe('ws://192.168.250.29:6768')
    expect(endpointOf('[fe80::1]:6768')).toBe('ws://[fe80::1]:6768')
  })

  it('classifies the endpoint kind the same way access links do', () => {
    expect(kindOf('100.76.32.125:6768')).toBe('tailscale')
    expect(kindOf('127.0.0.1:6768')).toBe('loopback')
    expect(kindOf('203.0.113.9:6768')).toBe('public')
  })

  it('rejects empty, whitespace, wildcards, paths, and http(s) schemes', () => {
    for (const bad of [
      '',
      '   ',
      '0.0.0.0:6768',
      'ws://0.0.0.0:6768',
      'ws://[::]:6768',
      'http://192.168.250.29:6768',
      'https://192.168.250.29:6768',
      'ws://192.168.250.29:6768/pair',
      'ws://192.168.250.29:6768?x=1',
      '192.168.250.29:0',
      '192.168.250.29:70000',
      '192.168.250.29:999999999999',
      'not a host',
      'http://192.168.250.29:6768/pair'
    ]) {
      expect(normalizeOpenAccessEndpoint(bad).ok, bad).toBe(false)
    }
  })
})

describe('buildOpenAccessPairing', () => {
  it('builds a valid offer with the default token, placeholder key, and the open-access flag', () => {
    const offer = buildOpenAccessPairing('192.168.250.29:6768')
    expect(offer).toEqual({
      v: 2,
      endpoint: 'ws://192.168.250.29:6768',
      deviceToken: DEFAULT_ORCA_ACCESS_KEY,
      publicKeyB64: 'TOFU',
      scope: 'runtime',
      openAccess: true
    })
  })

  it('round-trips through the pairing code encoder so the store can save it', () => {
    const offer = buildOpenAccessPairing('ws://192.168.250.29:6768')
    expect(offer).toBeTruthy()
    const code = encodePairingOffer(offer!)
    expect(code.startsWith('orca://pair?code=')).toBe(true)
    expect(parsePairingCode(code)).toEqual(offer)
  })

  it('returns null for an unusable address', () => {
    expect(buildOpenAccessPairing('0.0.0.0:6768')).toBeNull()
    expect(buildOpenAccessPairing('')).toBeNull()
  })
})

describe('isPlaceholderHostKey', () => {
  it('recognizes the placeholder in the same spellings host-key matching accepts', () => {
    expect(isPlaceholderHostKey('TOFU')).toBe(true)
    expect(isPlaceholderHostKey(' TOFU ')).toBe(true)
    expect(isPlaceholderHostKey('tofu')).toBe(false)
  })

  it('never matches a real host key', () => {
    const realKey = Buffer.from(new Uint8Array(32).fill(7)).toString('base64')
    expect(isPlaceholderHostKey(realKey)).toBe(false)
  })
})

describe('endpoint/token overrides over a parsed link', () => {
  const link = parseHostAccessLink(
    encodePairingOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'link-token',
      // 32 bytes of 1: a real key shape, unlike the placeholder.
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
    })
  )

  it('keeps the pinned host key when the endpoint is overridden', () => {
    if (!link.ok) {
      throw new Error('fixture link must parse')
    }
    const overridden = applyEndpointOverride(link.value, '192.168.250.29:6768')
    expect(overridden.ok).toBe(true)
    if (!overridden.ok) {
      return
    }
    expect(overridden.value.pairing.endpoint).toBe('ws://192.168.250.29:6768')
    expect(overridden.value.pairing.publicKeyB64).toBe(link.value.pairing.publicKeyB64)
    expect(overridden.value.pairing.deviceToken).toBe('link-token')
    // The override's kind, not the link's, decides the loopback rejection.
    expect(overridden.value.endpointKind).toBe('lan')
    expect(overridden.value.displayEndpoint).toBe('192.168.250.29:6768')
  })

  it('leaves the link untouched for an empty override and rejects an invalid address', () => {
    if (!link.ok) {
      throw new Error('fixture link must parse')
    }
    expect(applyEndpointOverride(link.value, '')).toEqual({ ok: true, value: link.value })
    expect(applyEndpointOverride(link.value, 'http://10.0.0.1:6768').ok).toBe(false)
  })

  it('swaps the token for the override and keeps the link token when empty', () => {
    if (!link.ok) {
      throw new Error('fixture link must parse')
    }
    expect(applyDeviceTokenOverride(link.value, DEFAULT_ORCA_ACCESS_KEY).pairing.deviceToken).toBe(
      DEFAULT_ORCA_ACCESS_KEY
    )
    expect(applyDeviceTokenOverride(link.value, '')).toBe(link.value)
  })
})
