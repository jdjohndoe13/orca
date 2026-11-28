import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { HubAddResult } from '../../../../../../shared/remote-runtime/hub/hub-link-ipc-types'
import type { NormalizeHubUrlResult } from '../../../../../../shared/remote-runtime/hub/hub-link-records'

/**
 * The hub save flow of the add-host dialog: main stores the link, fetches the hub's list, and
 * writes one row per instance. The dialog keeps only state and wiring; toasts are the outcome.
 */
export async function saveHubLinkFromForm({
  hubUrl,
  accessKey,
  normalizedHubUrl,
  hubUrlError,
  runtimeEnvironments,
  onSaved
}: {
  hubUrl: string
  accessKey: string
  normalizedHubUrl: NormalizeHubUrlResult | null
  hubUrlError: boolean
  runtimeEnvironments: {
    addHubLink?: (args: { hubUrl: string; accessKey: string }) => Promise<HubAddResult>
    list: () => Promise<PublicKnownRuntimeEnvironment[]>
  }
  onSaved: (environments: PublicKnownRuntimeEnvironment[]) => Promise<void> | void
}): Promise<boolean> {
  const trimmedHubUrl = hubUrl.trim()
  const trimmedAccessKey = accessKey.trim()
  if (trimmedHubUrl === '' || trimmedAccessKey === '') {
    toast.error(
      translate(
        'auto.components.sidebar.AddRemoteHostDialog.hubFieldsRequired',
        'Hub address and access key are required.'
      )
    )
    return false
  }
  if (hubUrlError || normalizedHubUrl?.ok !== true) {
    toast.error(
      normalizedHubUrl && !normalizedHubUrl.ok
        ? normalizedHubUrl.message
        : translate(
            'auto.components.sidebar.AddRemoteHostDialog.hubUrlError',
            'Enter the hub address, like hub.example.com:6770.'
          )
    )
    return false
  }
  if (!runtimeEnvironments.addHubLink) {
    toast.error(
      translate(
        'auto.components.sidebar.AddRemoteHostDialog.hubUnsupported',
        'Hubs are not available in this Orca.'
      )
    )
    return false
  }
  try {
    const result = await runtimeEnvironments.addHubLink({
      hubUrl: trimmedHubUrl,
      accessKey: trimmedAccessKey
    })
    if (!result.ok) {
      toast.error(result.message)
      return false
    }
    await onSaved(await runtimeEnvironments.list())
    toast.success(
      result.listed
        ? translate(
            'auto.components.sidebar.AddRemoteHostDialog.hubSaved',
            'Hub added. {{value0}} server(s) listed.',
            { value0: result.instances }
          )
        : translate(
            'auto.components.sidebar.AddRemoteHostDialog.hubSavedUnreachable',
            'Hub saved, but it could not be reached. Its servers will appear once it is reachable.'
          )
    )
    return true
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.sidebar.AddRemoteHostDialog.hubSaveFailed',
            'Failed to add the hub.'
          )
    )
    return false
  }
}
