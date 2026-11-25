import { Loader2, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { parseHostAccessLink } from '../../../../shared/remote-runtime/pairing/remote-pairing-address'
import {
  applyDeviceTokenOverride,
  applyEndpointOverride,
  normalizeOpenAccessEndpoint
} from '../../../../shared/remote-runtime/open-access/open-access-link'
import type { RemotePairingEndpointKind } from '../../../../shared/remote-runtime/pairing/remote-pairing-address'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { useTranslate } from '@/i18n/use-translate'
import {
  translateHostAccessLinkError,
  translateRemotePairingEndpointKind
} from '@/lib/remote-pairing/remote-pairing-copy'
import {
  defaultServerNameForAccessLink,
  defaultServerNameForOpenAccessAddress
} from '../../../../shared/remote-runtime/host-catalog/runtime-host-default-name'
import {
  RuntimeHostAccessFailureAlert,
  type RuntimeHostAccessFailure
} from './RuntimeHostAccessFailureAlert'

// Why untranslated: a literal shell command.
const HEADLESS_SERVE_COMMAND = 'orca serve --pairing-address <address>'

const NO_TAKEN_NAMES: readonly { name: string }[] = []

/** What the form submits: the link plus the two optional open-access overrides. */
export type RuntimeHostAccessSubmission = {
  allowLoopback: boolean
  endpointOverride?: string
  deviceTokenOverride?: string
}

type RuntimeHostAccessFormProps = {
  name: string
  /** Names already in use, so the blank-name default shown matches what will be saved. */
  takenNames?: readonly { name: string }[]
  accessLink: string
  busy: boolean
  failure: RuntimeHostAccessFailure | null
  onNameChange: (value: string) => void
  onAccessLinkChange: (value: string) => void
  onCancel: () => void
  onSubmit: (submission: RuntimeHostAccessSubmission) => void
}

/** The endpoint the form will actually dial, after the optional overrides win. */
type EffectiveEndpoint = {
  displayEndpoint: string
  endpointKind: RemotePairingEndpointKind
}

export function RuntimeHostAccessForm({
  name,
  takenNames = NO_TAKEN_NAMES,
  accessLink,
  busy,
  failure,
  onNameChange,
  onAccessLinkChange,
  onCancel,
  onSubmit
}: RuntimeHostAccessFormProps): React.JSX.Element {
  const t = useTranslate()
  const [allowLoopback, setAllowLoopback] = useState(false)
  const [address, setAddress] = useState('')
  const [accessKey, setAccessKey] = useState('')
  const trimmedAddress = address.trim()
  const trimmedAccessKey = accessKey.trim()
  const hasLink = accessLink.trim() !== ''
  const parsed = useMemo(() => parseHostAccessLink(accessLink), [accessLink])
  const openAccessMode = !hasLink && trimmedAddress !== ''
  const openAccessEndpoint = useMemo(
    () => (openAccessMode ? normalizeOpenAccessEndpoint(trimmedAddress) : null),
    [openAccessMode, trimmedAddress]
  )
  const addressError =
    trimmedAddress !== '' &&
    (openAccessMode
      ? !openAccessEndpoint?.ok
      : parsed.ok && !applyEndpointOverride(parsed.value, trimmedAddress).ok)
  // Why the same rule as main: the override wins over the link's endpoint, so the preview and the
  // loopback warning must describe the endpoint Orca will actually connect to.
  const effective = useMemo<EffectiveEndpoint | null>(() => {
    if (openAccessMode) {
      return openAccessEndpoint?.ok
        ? {
            displayEndpoint: openAccessEndpoint.value.displayEndpoint,
            endpointKind: openAccessEndpoint.value.endpointKind
          }
        : null
    }
    if (!parsed.ok || addressError) {
      return null
    }
    const overridden = applyEndpointOverride(
      applyDeviceTokenOverride(parsed.value, trimmedAccessKey),
      trimmedAddress
    )
    return overridden.ok
      ? {
          displayEndpoint: overridden.value.displayEndpoint,
          endpointKind: overridden.value.endpointKind
        }
      : null
  }, [addressError, openAccessEndpoint, openAccessMode, parsed, trimmedAccessKey, trimmedAddress])
  // The tunnel override applies to a link only; the IP-only mode names the address directly.
  const tunnelOverrideEnabled =
    allowLoopback && effective?.endpointKind === 'loopback' && parsed.ok && !openAccessMode
  const loopbackBlocked =
    effective?.endpointKind === 'loopback' && !tunnelOverrideEnabled && !openAccessMode
  const inputError = hasLink && !parsed.ok
  const describedBy = failure
    ? 'runtime-server-verification-error'
    : inputError
      ? 'runtime-server-access-link-error'
      : loopbackBlocked
        ? 'runtime-server-loopback-error'
        : 'runtime-server-access-link-help'
  const canSubmit =
    !busy &&
    !addressError &&
    (openAccessMode ? openAccessEndpoint?.ok === true : parsed.ok && !loopbackBlocked)
  const defaultName = openAccessMode
    ? defaultServerNameForOpenAccessAddress(trimmedAddress, takenNames)
    : defaultServerNameForAccessLink(accessLink, takenNames)

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) {
          onSubmit({
            allowLoopback: tunnelOverrideEnabled,
            ...(trimmedAddress !== '' ? { endpointOverride: trimmedAddress } : {}),
            ...(trimmedAccessKey !== '' ? { deviceTokenOverride: trimmedAccessKey } : {})
          })
        }
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="runtime-server-access-link">
          {t('auto.components.settings.RuntimeHostAccessForm.accessLink', 'Access link')}
        </Label>
        <Input
          id="runtime-server-access-link"
          aria-invalid={inputError || loopbackBlocked || failure !== null}
          aria-describedby={describedBy}
          value={accessLink}
          disabled={busy}
          onChange={(event) => {
            setAllowLoopback(false)
            onAccessLinkChange(event.target.value)
          }}
          placeholder={t(
            'auto.components.settings.RuntimeHostAccessForm.accessLinkPlaceholder',
            'orca://pair?code=...'
          )}
          className="min-w-0 font-mono"
          autoFocus
        />
        <p id="runtime-server-access-link-help" className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.RuntimeHostAccessForm.accessLinkHelp',
            'Orca shows the destination before connecting. Credentials stay hidden.'
          )}
        </p>
        {inputError ? (
          <p id="runtime-server-access-link-error" className="text-xs text-destructive">
            {parsed.ok ? null : translateHostAccessLinkError(parsed.kind, t)}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="runtime-server-address">
          {t('auto.components.settings.RuntimeHostAccessForm.addressLabel', 'Address')}{' '}
          <span className="font-normal text-muted-foreground">
            {t('auto.components.settings.RuntimeHostAccessForm.optional', '(optional)')}
          </span>
        </Label>
        <Input
          id="runtime-server-address"
          aria-invalid={addressError}
          value={address}
          disabled={busy}
          onChange={(event) => {
            setAllowLoopback(false)
            setAddress(event.target.value)
          }}
          placeholder={t(
            'auto.components.settings.RuntimeHostAccessForm.addressPlaceholder',
            'e.g. 192.168.250.29:6768'
          )}
          className="min-w-0 font-mono"
        />
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.RuntimeHostAccessForm.addressHelp',
            'Overrides the link destination. With no link, connects to a host that accepts any access key.'
          )}
        </p>
        {addressError ? (
          <p className="text-xs text-destructive">
            {t(
              'auto.components.settings.RuntimeHostAccessForm.addressError',
              'Enter an address like 192.168.250.29:6768 or ws://192.168.250.29:6768.'
            )}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="runtime-server-access-key">
          {t('auto.components.settings.RuntimeHostAccessForm.accessKeyLabel', 'Access key')}{' '}
          <span className="font-normal text-muted-foreground">
            {t('auto.components.settings.RuntimeHostAccessForm.optional', '(optional)')}
          </span>
        </Label>
        <Input
          id="runtime-server-access-key"
          value={accessKey}
          disabled={busy}
          onChange={(event) => setAccessKey(event.target.value)}
          placeholder={t(
            'auto.components.settings.RuntimeHostAccessForm.accessKeyPlaceholder',
            'e.g. default_orca_access_key'
          )}
          className="min-w-0 font-mono"
        />
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.RuntimeHostAccessForm.accessKeyHelp',
            'Overrides the link’s access key, for example the host’s fixed default key.'
          )}
        </p>
      </div>

      {effective ? (
        <div className="space-y-1 rounded-md border border-border/60 bg-background/60 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
            <span>
              {t('auto.components.settings.RuntimeHostAccessForm.destination', 'Link destination')}
            </span>
            <Badge variant="outline">
              {translateRemotePairingEndpointKind(effective.endpointKind, t)}
            </Badge>
          </div>
          <div className="font-mono text-sm" aria-live="polite">
            {effective.displayEndpoint}
          </div>
        </div>
      ) : null}

      {loopbackBlocked ? (
        <div
          id="runtime-server-loopback-error"
          role="alert"
          className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm"
        >
          <div className="font-medium text-destructive">
            {t(
              'auto.components.settings.RuntimeHostAccessForm.loopbackTitle',
              'This link points back to this device'
            )}
          </div>
          <p>
            {t(
              'auto.components.settings.RuntimeHostAccessForm.loopbackDescription',
              'It uses {{endpoint}}, which points back to the device opening the link—not the other computer that created it.',
              { endpoint: effective?.displayEndpoint ?? '' }
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.RuntimeHostAccessForm.loopbackRecoveryTunnel',
              'On the other computer, open Share this computer and create a link for Another device with its Tailscale or LAN address. If you reach it through an SSH tunnel, turn on the option below.'
            )}
          </p>
        </div>
      ) : null}

      {effective?.endpointKind === 'loopback' && !openAccessMode ? (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={allowLoopback}
            disabled={busy}
            onCheckedChange={(checked) => setAllowLoopback(checked === true)}
          />
          <span className="space-y-0.5">
            <span className="block">
              {t(
                'auto.components.settings.RuntimeHostAccessForm.sshTunnelReach',
                'I reach this address through an SSH tunnel'
              )}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t(
                'auto.components.settings.RuntimeHostAccessForm.sshTunnelHelp',
                'Keep the tunnel active while using this connection.'
              )}
            </span>
          </span>
        </label>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="runtime-server-name">
          {t('auto.components.settings.RuntimeHostAccessForm.nameLabel', 'Name')}{' '}
          <span className="font-normal text-muted-foreground">
            {t('auto.components.settings.RuntimeHostAccessForm.optional', '(optional)')}
          </span>
        </Label>
        <Input
          id="runtime-server-name"
          value={name}
          disabled={busy}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder={
            defaultName ||
            t('auto.components.settings.RuntimeHostAccessForm.namePlaceholder', 'Linux workstation')
          }
        />
      </div>

      {failure ? (
        <RuntimeHostAccessFailureAlert
          id="runtime-server-verification-error"
          failure={failure}
          endpoint={effective?.displayEndpoint ?? null}
        />
      ) : null}

      <p className="text-xs text-muted-foreground">
        {t(
          'auto.components.settings.RuntimeHostAccessForm.headlessHelpPrefix',
          'Running Orca without a window? On that computer, run'
        )}{' '}
        <code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">
          {HEADLESS_SERVE_COMMAND}
        </code>
      </p>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t('auto.components.settings.RuntimeHostAccessForm.cancel', 'Cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}
          {tunnelOverrideEnabled
            ? t(
                'auto.components.settings.RuntimeHostAccessForm.addServerWithTunnel',
                'Add via tunnel'
              )
            : t('auto.components.settings.RuntimeHostAccessForm.addServer', 'Add server')}
        </Button>
      </div>
    </form>
  )
}
