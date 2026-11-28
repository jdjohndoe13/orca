// The hub recomputes the instance id from the public key and recomputes the
// key-match digest from the client's access key. If either derivation differs
// from the hub's by even one byte, the hub silently refuses every registration
// this VM makes — so the reference values below are the hub's own
// (`orca-hub/src/hub/crypto.ts`), computed once and frozen here.
//
// The vector is the 32-byte key `00 01 02 ... 1f`, with the access key
// `test-access-key`. The id is the first 22 base64url chars of its SHA-256, and
// the digest is HMAC-SHA256 over the domain string concatenated with the id.

import { describe, expect, it } from 'vitest'
import { instanceIdFromPublicKey, keyMatchFor } from './hub-registration-crypto'
import {
  HUB_PROTOCOL_VERSION,
  buildRegisterFrame,
  parseHubInboundMessage
} from './hub-registration-protocol'

const KNOWN_PUBLIC_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const KNOWN_ACCESS_KEY = 'test-access-key'
const KNOWN_INSTANCE_ID = 'Yw3NKWbEM2aRElRIu7JbT_'
const KNOWN_KEY_MATCH = 'SY5D62TBckkcFGgBGr6YboO3l3IaCGOt7ngcQU8nqao'

describe('hub registration crypto', () => {
  it('derives the instance id the hub expects', () => {
    expect(instanceIdFromPublicKey(KNOWN_PUBLIC_KEY_B64)).toBe(KNOWN_INSTANCE_ID)
  })

  it('derives the key-match digest the hub expects', () => {
    expect(keyMatchFor(KNOWN_ACCESS_KEY, KNOWN_INSTANCE_ID)).toBe(KNOWN_KEY_MATCH)
  })

  it('refuses an empty public key rather than hashing nothing', () => {
    expect(() => instanceIdFromPublicKey('')).toThrow('public key is empty')
  })

  it('is deterministic across calls', () => {
    expect(instanceIdFromPublicKey(KNOWN_PUBLIC_KEY_B64)).toBe(
      instanceIdFromPublicKey(KNOWN_PUBLIC_KEY_B64)
    )
    expect(keyMatchFor(KNOWN_ACCESS_KEY, KNOWN_INSTANCE_ID)).toBe(
      keyMatchFor(KNOWN_ACCESS_KEY, KNOWN_INSTANCE_ID)
    )
  })

  it('changes the digest when the access key changes', () => {
    expect(keyMatchFor('other-key', KNOWN_INSTANCE_ID)).not.toBe(KNOWN_KEY_MATCH)
  })
})

describe('the register frame', () => {
  it('carries the id, digest and vm origin the hub validates', () => {
    const frame = buildRegisterFrame({
      instanceId: KNOWN_INSTANCE_ID,
      name: 'vm-1',
      publicKeyB64: KNOWN_PUBLIC_KEY_B64,
      keyMatch: KNOWN_KEY_MATCH,
      ports: [6768],
      capabilities: ['rpc']
    })
    expect(frame).toEqual({
      type: 'register',
      version: HUB_PROTOCOL_VERSION,
      instanceId: KNOWN_INSTANCE_ID,
      name: 'vm-1',
      publicKeyB64: KNOWN_PUBLIC_KEY_B64,
      keyMatch: KNOWN_KEY_MATCH,
      ports: [6768],
      capabilities: ['rpc'],
      path: [],
      hops: 0,
      origin: 'vm'
    })
    // The hub recomputes the id from the key and drops the frame on mismatch.
    expect(instanceIdFromPublicKey(frame.publicKeyB64)).toBe(frame.instanceId)
  })
})

describe('parseHubInboundMessage', () => {
  it('reads the welcome and applies no defaults to a real refreshMs', () => {
    expect(
      parseHubInboundMessage(
        JSON.stringify({ type: 'welcome', version: 1, hubId: 'hub-1', refreshMs: 15_000 })
      )
    ).toEqual({ type: 'welcome', version: 1, hubId: 'hub-1', refreshMs: 15_000 })
  })

  it('reads a reject reason', () => {
    expect(
      parseHubInboundMessage(
        JSON.stringify({ type: 'reject', version: 1, reason: 'bad_registration_secret' })
      )
    ).toEqual({ type: 'reject', version: 1, reason: 'bad_registration_secret' })
  })

  it('reads an ack and its reason', () => {
    expect(
      parseHubInboundMessage(
        JSON.stringify({
          type: 'ack',
          version: 1,
          instanceId: 'x',
          ok: false,
          reason: 'direct_wins'
        })
      )
    ).toEqual({ type: 'ack', version: 1, instanceId: 'x', ok: false, reason: 'direct_wins' })
  })

  it('drops malformed JSON and unknown control types', () => {
    expect(parseHubInboundMessage('not json')).toBeNull()
    expect(parseHubInboundMessage('[1,2,3]')).toBeNull()
    expect(parseHubInboundMessage(JSON.stringify({ type: 'auth', secret: 'x' }))).toBeNull()
  })
})
