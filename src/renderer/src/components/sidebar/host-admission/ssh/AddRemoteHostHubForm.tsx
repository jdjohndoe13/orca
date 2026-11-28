import { useState } from 'react'
import { useAppStore } from '@/store/index'
import { runWithFinally } from '@/lib/run-with-finally'
import { useAddRemoteHostHubFormState } from './use-add-remote-host-hub-form-state'
import { saveHubLinkFromForm } from './add-remote-host-hub-actions'
import { AddRemoteHostHubFormPanel } from './AddRemoteHostHubFormPanel'

/**
 * The hub form of the add-host dialog, owning its own fields and save call so the dialog stays
 * thin. Same shape as the WSL body: the dialog owns the busy flag and closes on success.
 */
export function AddRemoteHostHubForm({
  adding,
  onAddingChange,
  onAdded,
  onCancel
}: {
  adding: boolean
  onAddingChange: (adding: boolean) => void
  onAdded: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [hubUrl, setHubUrl] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const { hubUrlError, normalizedHubUrl, hubFormCanSubmit } = useAddRemoteHostHubFormState({
    hubUrl,
    accessKey
  })
  const setRuntimeEnvironments = useAppStore((s) => s.setRuntimeEnvironments)
  const readRuntimeHostStatusSnapshots = useAppStore((s) => s.readRuntimeHostStatusSnapshots)

  const save = async () => {
    onAddingChange(true)
    await runWithFinally(
      async () => {
        const saved = await saveHubLinkFromForm({
          hubUrl,
          accessKey,
          normalizedHubUrl,
          hubUrlError,
          runtimeEnvironments: window.api.runtimeEnvironments,
          onSaved: async (environments) => {
            setRuntimeEnvironments(environments)
            await readRuntimeHostStatusSnapshots()
          }
        })
        if (saved) {
          onAdded()
        }
      },
      () => onAddingChange(false)
    )
  }

  return (
    <AddRemoteHostHubFormPanel
      hubUrl={hubUrl}
      accessKey={accessKey}
      disabled={adding}
      canSubmit={hubFormCanSubmit}
      onHubUrlChange={setHubUrl}
      onAccessKeyChange={setAccessKey}
      onSubmit={() => void save()}
      onCancel={onCancel}
    />
  )
}
