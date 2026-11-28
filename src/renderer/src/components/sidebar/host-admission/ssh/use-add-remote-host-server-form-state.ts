import { useMemo } from 'react'
import {
  parseHostAccessLink,
  type ParseHostAccessLinkResult,
  type RemotePairingEndpointKind
} from '../../../../../../shared/remote-runtime/pairing/remote-pairing-address'
import {
  applyDeviceTokenOverride,
  applyEndpointOverride,
  normalizeOpenAccessEndpoint
} from '../../../../../../shared/remote-runtime/open-access/open-access-link'

/**
 * Derived state for the remote-server form of the add-host dialog: the pairing link, the
 * open-access (connect-by-IP) fallback, and how the two interact for the preview and submit
 * gating. Lives beside the dialog so the dialog keeps only state and wiring.
 */

export type EffectiveServerEndpoint = {
  displayEndpoint: string
  endpointKind: RemotePairingEndpointKind
}

export type AddRemoteHostServerFormState = {
  parsedServerLink: ParseHostAccessLinkResult
  openAccessMode: boolean
  serverAddressError: boolean
  effectiveServerEndpoint: EffectiveServerEndpoint | null
  serverFormCanSubmit: boolean
}

export function useAddRemoteHostServerFormState({
  serverName,
  pairingCode,
  serverAddress,
  serverAccessKey,
  allowLoopback
}: {
  serverName: string
  pairingCode: string
  serverAddress: string
  serverAccessKey: string
  allowLoopback: boolean
}): AddRemoteHostServerFormState {
  const parsedServerLink = useMemo(() => parseHostAccessLink(pairingCode), [pairingCode])
  const trimmedServerAddress = serverAddress.trim()
  const trimmedServerAccessKey = serverAccessKey.trim()
  const hasServerLink = pairingCode.trim() !== ''
  const openAccessMode = !hasServerLink && trimmedServerAddress !== ''
  const openAccessEndpoint = useMemo(
    () => (openAccessMode ? normalizeOpenAccessEndpoint(trimmedServerAddress) : null),
    [openAccessMode, trimmedServerAddress]
  )
  const serverAddressError =
    trimmedServerAddress !== '' &&
    (openAccessMode
      ? !openAccessEndpoint?.ok
      : parsedServerLink.ok &&
        !applyEndpointOverride(parsedServerLink.value, trimmedServerAddress).ok)
  // Why the same rule as main: the override wins over the link's endpoint for the preview and the
  // loopback check; with no link at all, the address itself is the destination.
  const effectiveServerEndpoint = useMemo(() => {
    if (openAccessMode) {
      return openAccessEndpoint?.ok
        ? {
            displayEndpoint: openAccessEndpoint.value.displayEndpoint,
            endpointKind: openAccessEndpoint.value.endpointKind
          }
        : null
    }
    if (!parsedServerLink.ok || serverAddressError) {
      return null
    }
    const overridden = applyEndpointOverride(
      applyDeviceTokenOverride(parsedServerLink.value, trimmedServerAccessKey),
      trimmedServerAddress
    )
    return overridden.ok
      ? {
          displayEndpoint: overridden.value.displayEndpoint,
          endpointKind: overridden.value.endpointKind
        }
      : null
  }, [
    openAccessEndpoint,
    openAccessMode,
    parsedServerLink,
    serverAddressError,
    trimmedServerAccessKey,
    trimmedServerAddress
  ])
  // Why the relaxed check: an empty link with an address is the connect-by-IP mode; only "no link
  // and no address" is unusable.
  const serverFormCanSubmit =
    serverName.trim() !== '' &&
    !serverAddressError &&
    (openAccessMode
      ? openAccessEndpoint?.ok === true
      : parsedServerLink.ok &&
        (effectiveServerEndpoint?.endpointKind !== 'loopback' || allowLoopback))

  return {
    parsedServerLink,
    openAccessMode,
    serverAddressError,
    effectiveServerEndpoint,
    serverFormCanSubmit
  }
}
