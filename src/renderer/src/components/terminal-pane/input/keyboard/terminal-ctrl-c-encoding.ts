import {
  KITTY_DISAMBIGUATE_ESCAPE_CODES,
  KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES,
  KITTY_REPORT_EVENT_TYPES
} from '../../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-flags'
import { encodeTerminalKittyCsiU } from './terminal-kitty-csi-u-encoding'

// Vended xterm reports ctrl+C as CSI-u under the disambiguate flag family
// (ctrl modifiers outrank shift in its useCsiU gate) and as legacy \x03 otherwise,
// never emitting alternates or text for ctrl chords (KittyKeyboard.ts useCsiU/_buildCsiUSequence).
const CTRL_C_DISAMBIGUATE_FAMILY_FLAGS =
  KITTY_DISAMBIGUATE_ESCAPE_CODES | KITTY_REPORT_EVENT_TYPES | KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES
const CTRL_C_PRIMARY_CODE_POINT = 'c'.charCodeAt(0)

export function resolveTerminalCtrlCInputEncoding(kittyFlags: number): string {
  if ((kittyFlags & CTRL_C_DISAMBIGUATE_FAMILY_FLAGS) === 0) {
    return '\x03'
  }
  return (
    encodeTerminalKittyCsiU({
      flags: kittyFlags,
      type: 'press',
      primaryCodePoint: CTRL_C_PRIMARY_CODE_POINT,
      shiftKey: false,
      altKey: false,
      ctrlKey: true,
      metaKey: false
    }) ?? '\x03'
  )
}
