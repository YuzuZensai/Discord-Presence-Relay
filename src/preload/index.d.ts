import { ElectronAPI } from '@electron-toolkit/preload'
import type { RelayApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: RelayApi
  }
}
