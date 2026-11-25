import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Checkbox } from '../../../ui/checkbox'
import { Label } from '../../../ui/label'
import { useTranslate } from '@/i18n/use-translate'
import type { MutableRefObject } from 'react'

/**
 * The open-access mode toggle of the runtime pairing panel: a checkbox that reads and writes the
 * host's accept-any-access-key mode. The mode lives in a file the registry reads live, so the
 * checkbox reflects the on-disk truth on mount. The web client's API proxy answers unknown
 * members with a placeholder, so the row shows only once the host has actually answered.
 */

/**
 * One open-access mode write, reported as data instead of a throw so the component
 * keeps its render path free of try/finally (a React Compiler bailout).
 */
async function runOpenAccessToggle(
  setOpenAccessMode: (args: { acceptAnyAccessKey: boolean }) => Promise<{ ok: boolean }>,
  next: boolean,
  failureMessage: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const result = await setOpenAccessMode({ acceptAnyAccessKey: next })
    if (result?.ok === false) {
      return { ok: false, message: failureMessage }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : failureMessage }
  }
}

export function RuntimePairingOpenAccessToggle({
  mountedRef
}: {
  mountedRef: MutableRefObject<boolean>
}): React.JSX.Element | null {
  const t = useTranslate()
  const getOpenAccessMode = window.api.runtimeEnvironments.getOpenAccessMode
  const [openAccessSupported, setOpenAccessSupported] = useState(false)
  const [acceptAnyAccessKey, setAcceptAnyAccessKey] = useState(false)
  const [isTogglingOpenAccess, setIsTogglingOpenAccess] = useState(false)

  useEffect(() => {
    if (!getOpenAccessMode) {
      return
    }
    let cancelled = false
    void getOpenAccessMode()
      .then((mode) => {
        if (!cancelled && mountedRef.current && typeof mode?.acceptAnyAccessKey === 'boolean') {
          setAcceptAnyAccessKey(mode.acceptAnyAccessKey)
          setOpenAccessSupported(true)
        }
      })
      .catch(() => {
        // An unreadable mode file reads as off; the toggle stays available and retries.
      })
    return () => {
      cancelled = true
    }
  }, [getOpenAccessMode, mountedRef])

  const toggleOpenAccessMode = async (next: boolean): Promise<void> => {
    // The bridge members are plain arrow functions; extracting them keeps the narrowing.
    const setOpenAccessMode = window.api.runtimeEnvironments.setOpenAccessMode
    if (!setOpenAccessMode) {
      return
    }
    setIsTogglingOpenAccess(true)
    const failureMessage = t(
      'auto.components.settings.RuntimePairingUrlGenerator.openAccessToggleFailed',
      'Failed to change the open-access mode.'
    )
    const result = await runOpenAccessToggle(setOpenAccessMode, next, failureMessage)
    if (mountedRef.current) {
      if (result.ok) {
        setAcceptAnyAccessKey(next)
      } else {
        toast.error(result.message)
      }
      setIsTogglingOpenAccess(false)
    }
  }

  if (!openAccessSupported) {
    return null
  }

  return (
    <div className="space-y-1 border-t border-border/40 pt-3">
      <div className="flex items-center gap-2">
        <Checkbox
          id="runtime-pairing-accept-any-access-key"
          checked={acceptAnyAccessKey}
          disabled={isTogglingOpenAccess}
          onCheckedChange={(checked) => void toggleOpenAccessMode(checked === true)}
        />
        <Label htmlFor="runtime-pairing-accept-any-access-key" variant="control">
          {t(
            'auto.components.settings.RuntimePairingUrlGenerator.acceptAnyAccessKey',
            'Accept any access key (LAN only)'
          )}
        </Label>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'auto.components.settings.RuntimePairingUrlGenerator.acceptAnyAccessKeyHelp',
          'Cloned machines accept any access key. Only use on a trusted network.'
        )}
      </p>
    </div>
  )
}
