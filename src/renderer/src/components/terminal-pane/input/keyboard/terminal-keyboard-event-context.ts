import type { KeyboardHandlersDeps } from './terminal-keyboard-dependencies'
import type { createTerminalKeyboardRuntime } from './terminal-keyboard-runtime'
import type { KeybindingPlatform } from '../../../../../../shared/keybindings/types'

type Runtime = ReturnType<typeof createTerminalKeyboardRuntime>

/**
 * The full context the keydown handler closes over: the shared deps plus the runtime
 * members the keydown path reaches directly. Lives beside the handlers so the handler
 * module stays within its line budget.
 */
export type TerminalKeyboardEventContext = KeyboardHandlersDeps & {
  isMac: boolean
  isWindows: boolean
  shortcutPlatform: KeybindingPlatform
  resolveShortcutEvent: Runtime['resolveShortcutEvent']
  createCapturedInputSender: Runtime['createCapturedInputSender']
  reconcileHeldImeEnterModifiers: Runtime['reconcileHeldImeEnterModifiers']
  getImeEnterModifier: Runtime['getImeEnterModifier']
  getModifiedEnterChord: Runtime['getModifiedEnterChord']
  getKeyboardSplitTelemetrySource: () => 'contextual_tour' | 'keyboard'
  getKittyKeyboardFlagsActivePane: Runtime['getKittyKeyboardFlagsActivePane']
  nativeOnlyShortcutTracker: Runtime['nativeOnlyShortcutTracker']
  optionKeyLocations: Runtime['optionKeyLocations']
  optionKittyReleases: Runtime['optionKittyReleases']
  heldImeEnterModifiers: Runtime['heldImeEnterModifiers']
  terminalImeEnterModifierKeydowns: Runtime['terminalImeEnterModifierKeydowns']
  deferredNewlineSender: Runtime['deferredNewlineSender']
  deferredChordSender: Runtime['deferredChordSender']
  modifiedEnterChordOwner: Runtime['modifiedEnterChordOwner']
  observedEnterKeydownTimeStamps: Runtime['observedEnterKeydownTimeStamps']
}
