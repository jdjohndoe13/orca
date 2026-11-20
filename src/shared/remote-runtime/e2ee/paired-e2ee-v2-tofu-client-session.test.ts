import { describe, expect, it } from 'vitest'
import { createMobileE2EEV2Fixture } from './mobile-e2ee-v2-fixtures'
import { createPairedE2EEClientHandshake } from './paired-e2ee-client-handshake'
import { NODE_PAIRED_E2EE_PRIMITIVES } from './node/paired-e2ee-node-primitives'

// Why the fixture's shared key: the vector fixes the ECDH output, so the only variable here is
// which desktop key the handshake accepts.
function handshakeFor(args: { hostPublicKeyB64: string; trustOnFirstUse?: boolean }) {
  const fixture = createMobileE2EEV2Fixture()
  const handshake = createPairedE2EEClientHandshake({
    primitives: { ...NODE_PAIRED_E2EE_PRIMITIVES, deriveSharedKey: () => fixture.sharedSecret },
    hostPublicKeyB64: args.hostPublicKeyB64,
    framing: 'v2',
    // The fixture's ready carries the relay context; hello and ready contexts must match.
    transport: 'relay',
    relayHostId: fixture.hello.context.relayHostId,
    clientKeyPair: { publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32) },
    clientNonce: new Uint8Array(32).fill(2),
    ...(args.trustOnFirstUse ? { trustOnFirstUse: true } : {})
  })
  return { fixture, handshake }
}

describe('paired E2EE client handshake: open-access trust-on-first-use', () => {
  it('accepts and keys the first ready when the offer carried a placeholder key', () => {
    const { fixture, handshake } = handshakeFor({
      hostPublicKeyB64: 'TOFU',
      trustOnFirstUse: true
    })
    expect(handshake.acceptReadyText(JSON.stringify(fixture.ready))).toBe('accepted')
    // Why a transcript: the schedule keyed the presented key, so the channel is usable end to end.
    expect(handshake.transcriptHashB64()).toBeTruthy()
    expect(handshake.channel.sealText('ping')).toBeTruthy()
  })

  it('still refuses a pinned offer whose ready comes from another key', () => {
    const { fixture, handshake } = handshakeFor({
      hostPublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    })
    expect(handshake.acceptReadyText(JSON.stringify(fixture.ready))).toBe('unexpected')
    expect(handshake.transcriptHashB64()).toBeNull()
  })

  it('accepts the pinned key exactly as before when the flag is absent', () => {
    const fixture = createMobileE2EEV2Fixture()
    const { handshake } = handshakeFor({
      hostPublicKeyB64: fixture.ready.desktopPublicKeyB64
    })
    expect(handshake.acceptReadyText(JSON.stringify(fixture.ready))).toBe('accepted')
    expect(handshake.transcriptHashB64()).toBeTruthy()
  })
})
