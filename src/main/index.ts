import { app, shell, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { relay, RelayStatus } from './relay'

declare const __COMMIT_HASH__: string

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function loadDisabledMirrors(): number[] {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data?.disabledMirrors) ? data.disabledMirrors : []
  } catch {
    return []
  }
}

function saveDisabledMirrors(indices: number[]): void {
  fs.writeFileSync(settingsPath(), JSON.stringify({ disabledMirrors: indices }), 'utf8')
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

function createWindow(): void {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
    return
  }

  mainWindow = new BrowserWindow({
    width: 420,
    height: 760,
    show: false,
    autoHideMenuBar: true,
    resizable: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      mainWindow?.destroy()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  const trayIcon = nativeImage.createFromPath(icon).resize({ width: 24, height: 24 })
  tray = new Tray(trayIcon)
  tray.setToolTip('Discord RPC Relay')

  updateTrayMenu(relay.getStatus())

  tray.on('click', () => {
    createWindow()
  })
}

function updateTrayMenu(status: RelayStatus): void {
  if (!tray) return

  const menu = Menu.buildFromTemplate([
    {
      label: status.running ? 'Relay: Running' : 'Relay: Stopped',
      enabled: false
    },
    { type: 'separator' },
    {
      label: status.running ? 'Stop Relay' : 'Start Relay',
      click: async () => {
        try {
          if (status.running) {
            await relay.stop()
          } else {
            await relay.start()
          }
        } catch (err) {
          console.error(err)
        }
      }
    },
    {
      label: 'Show Window',
      click: () => createWindow()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(menu)
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('cafe.kirameki.discord-rpc-relay')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  relay.setDisabledMirrors(loadDisabledMirrors())

  ipcMain.handle('relay:get-version', () => ({
    version: app.getVersion(),
    commit: __COMMIT_HASH__
  }))
  ipcMain.handle('relay:get-status', () => relay.getStatus())
  ipcMain.handle('relay:start', () => relay.start())
  ipcMain.handle('relay:stop', () => relay.stop())
  ipcMain.handle('relay:get-autostart', () => app.getLoginItemSettings().openAtLogin)
  ipcMain.handle('relay:set-autostart', (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled })
    return app.getLoginItemSettings().openAtLogin
  })
  ipcMain.handle('relay:set-mirror-enabled', (_e, index: number, enabled: boolean) => {
    const status = relay.setMirrorEnabled(index, enabled)
    saveDisabledMirrors(relay.getDisabledMirrors())
    return status
  })

  relay.on('status', (status: RelayStatus) => {
    updateTrayMenu(status)
    mainWindow?.webContents.send('relay:status', status)
  })

  createTray()
  createWindow()

  relay.start().catch((err) => console.error('Failed to start relay:', err))

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Keep running in the tray
})

let stopping = false

app.on('before-quit', (e) => {
  quitting = true
  if (stopping) return
  stopping = true
  e.preventDefault()
  relay.stop().finally(() => app.exit(0))
})
