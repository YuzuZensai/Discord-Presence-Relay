import { app, shell, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { relay, BlacklistedApp, RelayStatus } from './relay'

declare const __COMMIT_HASH__: string

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

interface Settings {
  disabledMirrors: number[]
  blacklistedApps: BlacklistedApp[]
  startMinimized: boolean
  lockedPrimary: string | null
}

function parseBlacklistedApps(raw: unknown): BlacklistedApp[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): BlacklistedApp[] =>
    entry && typeof entry.id === 'string'
      ? [{ id: entry.id, name: typeof entry.name === 'string' ? entry.name : null }]
      : []
  )
}

function loadSettings(): Settings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8')
    const data = JSON.parse(raw)
    return {
      disabledMirrors: Array.isArray(data?.disabledMirrors) ? data.disabledMirrors : [],
      blacklistedApps: parseBlacklistedApps(data?.blacklistedApps),
      startMinimized: data?.startMinimized === true,
      lockedPrimary: typeof data?.lockedPrimary === 'string' ? data.lockedPrimary : null
    }
  } catch {
    return { disabledMirrors: [], blacklistedApps: [], startMinimized: false, lockedPrimary: null }
  }
}

function saveSettings(settings: Settings): void {
  const target = settingsPath()
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(settings), 'utf8')
  fs.renameSync(tmp, target)
}

const LINUX_AUTOSTART_DESKTOP_FILE = join(
  app.getPath('home'),
  '.config',
  'autostart',
  'cafe.kirameki.discord-rpc-relay.desktop'
)

function getLinuxAutostart(): boolean {
  return fs.existsSync(LINUX_AUTOSTART_DESKTOP_FILE)
}

function setLinuxAutostart(enabled: boolean, startMinimized: boolean): boolean {
  if (!enabled) {
    fs.rmSync(LINUX_AUTOSTART_DESKTOP_FILE, { force: true })
    return false
  }

  const exe = process.env.APPIMAGE ?? app.getPath('exe')
  const exec = startMinimized ? `"${exe}" --hidden` : `"${exe}"`
  const desktopEntry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Discord RPC Relay',
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true'
  ].join('\n')

  fs.mkdirSync(join(app.getPath('home'), '.config', 'autostart'), { recursive: true })
  fs.writeFileSync(LINUX_AUTOSTART_DESKTOP_FILE, desktopEntry + '\n', 'utf8')
  return true
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
}

function shouldStartHidden(): boolean {
  if (process.argv.includes('--hidden')) return true
  if (process.platform === 'darwin') {
    return app.getLoginItemSettings().wasOpenedAtLogin && loadSettings().startMinimized
  }
  return false
}

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
    if (!shouldStartHidden()) {
      mainWindow?.show()
    }
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
      label: status.running
        ? 'Relay: Running'
        : status.waiting
          ? 'Relay: Waiting for Discord…'
          : 'Relay: Stopped',
      enabled: false
    },
    { type: 'separator' },
    {
      label: status.running || status.waiting ? 'Stop Relay' : 'Start Relay',
      click: async () => {
        try {
          if (status.running || status.waiting) {
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

app.on('second-instance', () => {
  createWindow()
})

app.whenReady().then(() => {
  electronApp.setAppUserModelId('cafe.kirameki.discord-rpc-relay')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const settings = loadSettings()
  relay.setDisabledMirrors(settings.disabledMirrors)
  relay.setBlacklistedApps(settings.blacklistedApps)
  relay.setLockedPrimary(settings.lockedPrimary)

  ipcMain.handle('relay:get-version', () => ({
    version: app.getVersion(),
    commit: __COMMIT_HASH__
  }))
  ipcMain.handle('relay:get-status', () => relay.getStatus())
  ipcMain.handle('relay:start', () => relay.start())
  ipcMain.handle('relay:stop', () => relay.stop())
  ipcMain.handle('relay:get-autostart', () => {
    if (process.platform === 'linux') return getLinuxAutostart()
    return app.getLoginItemSettings().openAtLogin
  })
  ipcMain.handle('relay:set-autostart', (_e, enabled: boolean) => {
    const current = loadSettings()
    if (process.platform === 'linux') {
      return setLinuxAutostart(enabled, current.startMinimized)
    }
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: current.startMinimized ? ['--hidden'] : []
    })
    return app.getLoginItemSettings().openAtLogin
  })
  ipcMain.handle('relay:get-start-minimized', () => loadSettings().startMinimized)
  ipcMain.handle('relay:set-start-minimized', (_e, enabled: boolean) => {
    const current = loadSettings()
    saveSettings({ ...current, startMinimized: enabled })

    if (process.platform === 'linux') {
      if (getLinuxAutostart()) setLinuxAutostart(true, enabled)
    } else if (app.getLoginItemSettings().openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, args: enabled ? ['--hidden'] : [] })
    }

    return enabled
  })
  ipcMain.handle('relay:set-mirror-enabled', (_e, index: number, enabled: boolean) => {
    const status = relay.setMirrorEnabled(index, enabled)
    const current = loadSettings()
    saveSettings({ ...current, disabledMirrors: relay.getDisabledMirrors() })
    return status
  })
  ipcMain.handle('relay:set-app-blacklisted', (_e, appId: string, blacklisted: boolean) => {
    const status = relay.setAppBlacklisted(appId, blacklisted)
    const current = loadSettings()
    saveSettings({ ...current, blacklistedApps: relay.getBlacklistedApps() })
    return status
  })
  ipcMain.handle('relay:unlock-primary', () => {
    const status = relay.unlockPrimary()
    const current = loadSettings()
    saveSettings({ ...current, lockedPrimary: relay.getLockedPrimary() })
    return status
  })
  ipcMain.handle('relay:promote-to-primary', async (_e, index: number) => {
    const status = await relay.promoteToPrimary(index)
    const current = loadSettings()
    saveSettings({ ...current, lockedPrimary: relay.getLockedPrimary() })
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

app.on('window-all-closed', () => {})

let stopping = false

const QUIT_TIMEOUT_MS = 5000

app.on('before-quit', (e) => {
  quitting = true
  if (stopping) return
  stopping = true
  e.preventDefault()
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS))
  Promise.race([relay.stop(), timeout])
    .catch(() => {})
    .finally(() => {
      relay.emergencyRestoreSync()
      app.exit(0)
    })
})

// Electron doesn't reliably turn SIGTERM/SIGHUP into a quit on Linux.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    quitting = true
    app.quit()
  })
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
  relay.emergencyRestoreSync()
  app.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason)
})
