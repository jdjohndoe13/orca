import { useMemo } from 'react'
import {
  normalizeHubUrl,
  type NormalizeHubUrlResult
} from '../../../../../../shared/remote-runtime/hub/hub-link-records'

/**
 * Derived state for the hub form of the add-host dialog: the two fields the user types (hub
 * address and access key) and what they mean. Lives beside the dialog so the dialog keeps only
 * state and wiring.
 */

export type AddRemoteHostHubFormState = {
  normalizedHubUrl: NormalizeHubUrlResult | null
  hubUrlError: boolean
  hubFormCanSubmit: boolean
}

export function useAddRemoteHostHubFormState({
  hubUrl,
  accessKey
}: {
  hubUrl: string
  accessKey: string
}): AddRemoteHostHubFormState {
  const trimmedHubUrl = hubUrl.trim()
  const normalizedHubUrl = useMemo(
    () => (trimmedHubUrl === '' ? null : normalizeHubUrl(trimmedHubUrl)),
    [trimmedHubUrl]
  )
  // Only flag a bad address once the user has typed something; an empty field is merely incomplete.
  const hubUrlError = trimmedHubUrl !== '' && normalizedHubUrl?.ok !== true
  return {
    normalizedHubUrl,
    hubUrlError,
    hubFormCanSubmit: normalizedHubUrl?.ok === true && !hubUrlError && accessKey.trim() !== ''
  }
}
