import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX } from '../../../../../../shared/rpc-contract/runtime-environment-relay-params'
import {
  RuntimeRpcCallError,
  isRuntimeScopeForbiddenError
} from '../../../../runtime/rpc/calls/runtime-rpc-result'
import { RUNTIME_SCOPE_FORBIDDEN_TOAST_ID } from './worktree-slice-constants'

// Code 'forbidden' is shared with the mobile-scope fence; the relay fences
// (gateway dispatch and its local bridge) also attach the relay allowlist
// wording, which is the only stable way to tell the two apart.
export function isRemoteRuntimeRelayForbiddenError(error: unknown): error is RuntimeRpcCallError {
  return (
    error instanceof RuntimeRpcCallError &&
    error.code === 'forbidden' &&
    error.message.startsWith(REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX)
  )
}

function showRuntimeRelayForbiddenToast(): void {
  toast.error(
    translate(
      'auto.store.slices.worktrees.runtimeRelayForbiddenTitle',
      "That action isn't available on a view-only relay connection yet."
    ),
    { id: RUNTIME_SCOPE_FORBIDDEN_TOAST_ID }
  )
}

/** Message-level variant for callers that already unboxed an RPC failure into
 *  a plain string (e.g. a terminal-create outcome); the allowlist wording is
 *  the only stable marker there. The sonner toast id dedupes repeats. */
export function notifyRuntimeRelayForbiddenMessage(message: string): boolean {
  if (!message.startsWith(REMOTE_RUNTIME_RELAY_REFUSAL_PREFIX)) {
    return false
  }
  showRuntimeRelayForbiddenToast()
  return true
}

export function notifyRuntimeScopeForbiddenIfNeeded(error: unknown): boolean {
  if (isRemoteRuntimeRelayForbiddenError(error)) {
    showRuntimeRelayForbiddenToast()
    return true
  }
  if (!isRuntimeScopeForbiddenError(error)) {
    return false
  }
  toast.error(
    translate(
      'auto.store.slices.worktrees.runtimeScopeForbiddenTitle',
      'This connection has limited (mobile) access'
    ),
    {
      id: RUNTIME_SCOPE_FORBIDDEN_TOAST_ID,
      description: translate(
        'auto.store.slices.worktrees.runtimeScopeForbiddenDescription',
        'Workspaces are unavailable on a mobile-scope pairing. Reconnect using the browser access link from Settings → Runtime Environments → Share this Orca server.'
      )
    }
  )
  return true
}
