import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ParseHostAccessLinkResult } from '../../../../../../shared/remote-runtime/pairing/remote-pairing-address'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { VerifyAndAddRuntimeEnvironmentResult } from '../../../../../../shared/remote-runtime/pairing/remote-pairing-verification'
import {
  translateHostAccessLinkError,
  translateRemotePairingFailureDescription
} from '@/lib/remote-pairing/remote-pairing-copy'
import { remoteServerPairingFailureMessage } from '@/lib/remote-pairing/remote-server-pairing-error-copy'
import type { EffectiveServerEndpoint } from './use-add-remote-host-server-form-state'

/**
 * The remote-server (pairing-link / open-access) save flow of the add-host dialog, extracted so
 * the dialog keeps only state and wiring. Toasts are the user-visible outcome; the caller
 * supplies the store mutations and refreshes on success.
 */
export async function saveRemoteServerFromForm({
  serverName,
  pairingCode,
  serverAddress,
  serverAccessKey,
  allowLoopback,
  parsedServerLink,
  serverAddressError,
  effectiveServerEndpoint,
  runtimeEnvironments,
  onSaved
}: {
  serverName: string
  pairingCode: string
  serverAddress: string
  serverAccessKey: string
  allowLoopback: boolean
  parsedServerLink: ParseHostAccessLinkResult
  serverAddressError: boolean
  effectiveServerEndpoint: EffectiveServerEndpoint | null
  runtimeEnvironments: {
    verifyAndAddFromPairingCode: (args: {
      name: string
      pairingCode: string
      allowLoopback: boolean
      endpointOverride?: string
      deviceTokenOverride?: string
    }) => Promise<VerifyAndAddRuntimeEnvironmentResult>
    list: () => Promise<PublicKnownRuntimeEnvironment[]>
  }
  onSaved: (environments: PublicKnownRuntimeEnvironment[]) => Promise<void> | void
}): Promise<boolean> {
  const trimmedName = serverName.trim()
  const trimmedPairingCode = pairingCode.trim()
  const trimmedServerAddress = serverAddress.trim()
  const trimmedServerAccessKey = serverAccessKey.trim()
  // Why the relaxed check: an empty link with an address is the connect-by-IP mode; the main
  // process builds the open-access offer there, so only "no link and no address" is unusable.
  if (!trimmedName || (trimmedPairingCode === '' && trimmedServerAddress === '')) {
    toast.error(
      translate(
        'auto.components.sidebar.AddRemoteHostDialog.serverFieldsRequired',
        'Server name and pairing code are required.'
      )
    )
    return false
  }
  if (trimmedPairingCode !== '' && !parsedServerLink.ok) {
    toast.error(translateHostAccessLinkError(parsedServerLink.kind))
    return false
  }
  if (serverAddressError) {
    toast.error(
      translate(
        'auto.components.sidebar.AddRemoteHostDialog.addressError',
        'Enter an address like 192.168.250.29:6768 or ws://192.168.250.29:6768.'
      )
    )
    return false
  }
  if (effectiveServerEndpoint?.endpointKind === 'loopback' && !allowLoopback) {
    toast.error(
      translate(
        'auto.components.sidebar.AddRemoteHostDialog.loopbackBlocked',
        'Enable the SSH tunnel override or create a new link using the other host’s Tailscale or LAN address.'
      )
    )
    return false
  }

  try {
    const result = await runtimeEnvironments.verifyAndAddFromPairingCode({
      name: trimmedName,
      pairingCode: trimmedPairingCode,
      allowLoopback,
      ...(trimmedServerAddress !== '' ? { endpointOverride: trimmedServerAddress } : {}),
      ...(trimmedServerAccessKey !== '' ? { deviceTokenOverride: trimmedServerAccessKey } : {})
    })
    if (!result.ok) {
      toast.error(
        result.kind === 'environment-save-failed'
          ? remoteServerPairingFailureMessage(result)
          : translateRemotePairingFailureDescription(
              result.kind,
              effectiveServerEndpoint?.displayEndpoint ?? ''
            )
      )
      return false
    }
    const environments = await runtimeEnvironments.list()
    await onSaved(environments)
    toast.success(
      result.updatedExisting
        ? translate(
            'auto.components.sidebar.AddRemoteHostDialog.serverAlreadyPaired',
            'This server is already paired as {{value0}}; updated its connection.',
            { value0: result.environment.name }
          )
        : translate(
            'auto.components.sidebar.AddRemoteHostDialog.serverSaved',
            'Remote server added.'
          )
    )
    return true
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.sidebar.AddRemoteHostDialog.serverSaveFailed',
            'Failed to add remote server.'
          )
    )
    return false
  }
}
