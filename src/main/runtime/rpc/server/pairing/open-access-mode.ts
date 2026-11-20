// Fork extension: host-side storage for the "accept any access key" LAN mode.
// The registry reads the mode file on every auth path so the share dialog's toggle takes
// effect without a restart, and a flip to off revokes immediately.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableSecureJsonFile } from '../../../../../shared/secure-storage/secure-file'
import { getAppEnvironment } from '../../../../../shared/app-lifecycle/app-environment'
import {
  OPEN_ACCESS_MODE_FILENAME,
  parseOpenAccessModeFile,
  type OpenAccessModeFile
} from '../../../../../shared/remote-runtime/open-access/open-access'

const OPEN_ACCESS_MODE_OFF: OpenAccessModeFile = { acceptAnyAccessKey: false }

/** The mode file's location beside orca-devices.json in the server's userData dir. */
export function openAccessModePath(userDataPath: string): string {
  return join(userDataPath, OPEN_ACCESS_MODE_FILENAME)
}

/** Read the mode file at `filePath`; missing, unreadable, or corrupt all mean off. */
export function readOpenAccessModeFile(filePath: string): OpenAccessModeFile {
  try {
    return parseOpenAccessModeFile(readFileSync(filePath, 'utf8'))
  } catch {
    // A lost file is a lost mode, not a broken host: the default is off.
    return OPEN_ACCESS_MODE_OFF
  }
}

/** Read the mode file from the server's userData dir. */
export function readOpenAccessMode(userDataPath: string): OpenAccessModeFile {
  return readOpenAccessModeFile(openAccessModePath(userDataPath))
}

/**
 * True only while the host's own userData mode file says on. Read fresh per call: the
 * capability list is built per status.get, so toggling must not need a restart. Never
 * throws — an unavailable app environment or unreadable file means off, and capability
 * advertisement must not fail over a mode file.
 */
export function openAccessModeEnabledForHost(): boolean {
  try {
    return readOpenAccessMode(getAppEnvironment().getPath('userData')).acceptAnyAccessKey
  } catch {
    return false
  }
}

/** Publish the mode file durably (same atomic writer as the registry); failures propagate. */
export function writeOpenAccessMode(userDataPath: string, mode: OpenAccessModeFile): void {
  writeDurableSecureJsonFile(openAccessModePath(userDataPath), mode)
}
