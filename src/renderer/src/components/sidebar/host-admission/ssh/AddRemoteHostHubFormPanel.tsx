import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'

/**
 * The hub form of the add-host dialog: two fields. The hub lists its instances itself, so there is
 * nothing else to fill in — Orca saves one server row per instance the hub returns.
 */
export function AddRemoteHostHubFormPanel({
  hubUrl,
  accessKey,
  disabled,
  canSubmit,
  onHubUrlChange,
  onAccessKeyChange,
  onSubmit,
  onCancel
}: {
  hubUrl: string
  accessKey: string
  disabled: boolean
  canSubmit: boolean
  onHubUrlChange: (value: string) => void
  onAccessKeyChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t('auto.components.sidebar.AddRemoteHostDialog.hubTitle', 'Add hub')}
        </DialogTitle>
        <DialogDescription>
          {t(
            'auto.components.sidebar.AddRemoteHostDialog.hubDescription',
            'Add every server an Orca hub lists for your access key.'
          )}
        </DialogDescription>
      </DialogHeader>

      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit()
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="add-hub-url">
            {t('auto.components.sidebar.AddRemoteHostDialog.hubUrl', 'Hub address')}
          </Label>
          <Input
            id="add-hub-url"
            value={hubUrl}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            placeholder={t(
              'auto.components.sidebar.AddRemoteHostDialog.hubUrlPlaceholder',
              'hub.example.com:6770'
            )}
            onChange={(event) => onHubUrlChange(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="add-hub-access-key">
            {t('auto.components.sidebar.AddRemoteHostDialog.hubAccessKey', 'Access key')}
          </Label>
          <Input
            id="add-hub-access-key"
            type="password"
            value={accessKey}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => onAccessKeyChange(event.target.value)}
          />
        </div>

        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.sidebar.AddRemoteHostDialog.hubRunsAsYou',
            'This device will be able to run commands as you on every listed server.'
          )}
        </p>

        <DialogFooter className="sm:justify-between">
          <span />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onCancel} disabled={disabled}>
              {t('auto.components.sidebar.AddRemoteHostDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={disabled || !canSubmit}>
              {disabled
                ? t('auto.components.sidebar.AddRemoteHostDialog.saving', 'Saving...')
                : t('auto.components.sidebar.AddRemoteHostDialog.save', 'Save')}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </>
  )
}
