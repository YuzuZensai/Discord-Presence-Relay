import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { RelayStatus } from '../main/relay'

const api = {
  getVersion: (): Promise<{ version: string; commit: string }> =>
    ipcRenderer.invoke('relay:get-version'),
  getStatus: (): Promise<RelayStatus> => ipcRenderer.invoke('relay:get-status'),
  start: (): Promise<void> => ipcRenderer.invoke('relay:start'),
  stop: (): Promise<void> => ipcRenderer.invoke('relay:stop'),
  getAutostart: (): Promise<boolean> => ipcRenderer.invoke('relay:get-autostart'),
  setAutostart: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('relay:set-autostart', enabled),
  getStartMinimized: (): Promise<boolean> => ipcRenderer.invoke('relay:get-start-minimized'),
  setStartMinimized: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke('relay:set-start-minimized', enabled),
  setMirrorEnabled: (index: number, enabled: boolean): Promise<RelayStatus> =>
    ipcRenderer.invoke('relay:set-mirror-enabled', index, enabled),
  setAppBlacklisted: (appId: string, blacklisted: boolean): Promise<RelayStatus> =>
    ipcRenderer.invoke('relay:set-app-blacklisted', appId, blacklisted),
  unlockPrimary: (): Promise<RelayStatus> => ipcRenderer.invoke('relay:unlock-primary'),
  promoteToPrimary: (index: number): Promise<RelayStatus> =>
    ipcRenderer.invoke('relay:promote-to-primary', index),
  onStatus: (callback: (status: RelayStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: RelayStatus): void => callback(status)
    ipcRenderer.on('relay:status', listener)
    return () => ipcRenderer.removeListener('relay:status', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

export type RelayApi = typeof api
