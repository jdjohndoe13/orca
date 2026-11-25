import { useMainSidebarListModel } from './use-main-list-model'
import { useWindowSidebarListModel } from './use-window-list-model'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-list/feed/sidebar-inputs-switch'

// Desktop windows consume main’s sidebar inputs; paired web clients derive their own view.
export const useSidebarListModel =
  ORCA_SIDEBAR_INPUTS_IS_MAIN && !isPairedWebClientWindow()
    ? useMainSidebarListModel
    : useWindowSidebarListModel
