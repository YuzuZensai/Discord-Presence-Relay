import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import * as net from 'net'
import { encodeFrame, Frame, FrameReader, OP_HANDSHAKE, parseFramePayload } from './ipc-protocol'
import { MirrorConnection } from './mirror-connection'
import { platform, MAX_SOCKETS, type ClaimedSocket, type ProcessInfo } from './platform'

const DISCOVERY_INTERVAL_MS = 3000
const WAITING_RETRY_INTERVAL_MS = 3000
const MIRROR_RECONNECT_DELAY_MS = 2000
const SERVER_CLOSE_TIMEOUT_MS = 2000
const ASSET_FETCH_RETRY_MS = 60_000

const PROCESS_EXIT_TIMEOUT_MS = 8000
const PROCESS_EXIT_POLL_MS = 200
const SLOT_BIND_TIMEOUT_MS = 20_000
const SLOT_BIND_POLL_MS = 300

interface AppAsset {
  id: string
  type: number
  name: string
}

interface AssetCacheEntry {
  map: Map<string, string>
  expires: number
}

const appAssetCache = new Map<string, AssetCacheEntry>()

async function getAppAssetMap(appId: string): Promise<Map<string, string>> {
  const cached = appAssetCache.get(appId)
  if (cached && Date.now() < cached.expires) return cached.map

  const map = new Map<string, string>()
  let expires = Number.POSITIVE_INFINITY
  try {
    const res = await fetch(`https://discord.com/api/v9/oauth2/applications/${appId}/assets`)
    if (res.ok) {
      const assets = (await res.json()) as AppAsset[]
      for (const asset of assets) map.set(asset.name, asset.id)
    } else {
      expires = Date.now() + ASSET_FETCH_RETRY_MS
    }
  } catch {
    expires = Date.now() + ASSET_FETCH_RETRY_MS
  }

  appAssetCache.set(appId, { map, expires })
  return map
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clearActivityPayload(pid: number): Buffer {
  return Buffer.from(
    JSON.stringify({ cmd: 'SET_ACTIVITY', args: { pid, activity: null }, nonce: randomUUID() }),
    'utf8'
  )
}

async function resolveAssetImage(
  key: string | undefined,
  appId: string | null
): Promise<string | null> {
  if (!key) return null
  if (key.startsWith('mp:external/')) {
    return `https://media.discordapp.net/external/${key.slice('mp:external/'.length)}`
  }
  if (key.startsWith('mp:')) {
    return `https://media.discordapp.net/${key.slice('mp:'.length)}`
  }
  if (key.startsWith('http://') || key.startsWith('https://')) return key
  if (!appId) return null

  // Numeric snowflake asset ids can be used directly.
  if (/^\d+$/.test(key)) return `https://cdn.discordapp.com/app-assets/${appId}/${key}.png`

  // Named assets need resolving to their numeric id via the app's asset list.
  const assetMap = await getAppAssetMap(appId)
  const assetId = assetMap.get(key)
  if (!assetId) return null
  return `https://cdn.discordapp.com/app-assets/${appId}/${assetId}.png`
}

export interface RelayInstance {
  index: number
  path: string
  isPrimary: boolean
  enabled: boolean
  locked: boolean
  process: ProcessInfo | null
}

export interface BlacklistedApp {
  id: string
  name: string | null
}

export interface ConnectedClient {
  id: number
  process: ProcessInfo | null
  appId: string | null
  blacklisted: boolean
  activity: LastActivity | null
}

export interface ActivityAssets {
  largeImage: string | null
  largeText: string | null
  smallImage: string | null
  smallText: string | null
}

export interface ActivityTimestamps {
  start: number | null
  end: number | null
}

export interface ActivityButton {
  label: string
  url: string
}

export interface LastActivity {
  app: string | null
  details: string | null
  state: string | null
  assets: ActivityAssets | null
  timestamps: ActivityTimestamps | null
  buttons: ActivityButton[]
  at: number
}

export interface RelayStatus {
  running: boolean
  waiting: boolean
  unsupported: boolean
  instances: RelayInstance[]
  connectedClients: ConnectedClient[]
  blacklistedApps: BlacklistedApp[]
  lockedPrimary: string | null
  reordering: boolean
  primaryOutOfOrder: boolean
  error: string | null
}

interface ClientSession {
  id: number
  client: net.Socket
  primary: net.Socket
  process: ProcessInfo | null
  handshakePayload: Buffer | null
  appId: string | null
  lastActivityPayload: Buffer | null
  lastActivityPid: number | null
  activity: LastActivity | null
  mirrors: Map<number, MirrorConnection>
  reconnectTimers: Map<number, NodeJS.Timeout>
  closed: boolean
}

/** Hijacks discord-ipc-0, passthrough to primary, mirroring frames to other instances. */
export class RpcRelay extends EventEmitter {
  private server: net.Server | null = null
  private claimed: ClaimedSocket[] = []
  private disabledMirrors = new Set<number>()
  private blacklistedApps = new Map<string, string | null>()
  private sessions = new Map<number, ClientSession>()
  private nextClientId = 1
  private discoveryTimer: NodeJS.Timeout | null = null
  private discovering = false
  private waitingTimer: NodeJS.Timeout | null = null
  private running = false
  private waiting = false
  private fakeOwned = false
  private lastError: string | null = null
  private restarting = false
  private lockedPrimary: string | null = null
  private reordering = false

  getStatus(): RelayStatus {
    const instances: RelayInstance[] = this.claimed.map(({ index, path: socketPath }, i) => {
      const process = platform.getInstanceProcess(index)
      return {
        index,
        path: socketPath,
        isPrimary: i === 0,
        enabled: i === 0 || !this.disabledMirrors.has(index),
        locked: this.isLockedInstance(process),
        process
      }
    })

    return {
      running: this.running,
      waiting: this.waiting,
      unsupported: !platform.isSupported,
      instances,
      connectedClients: [...this.sessions.values()].map((s) => ({
        id: s.id,
        process: s.process,
        appId: s.appId,
        blacklisted: this.isBlacklisted(s),
        activity: s.activity
      })),
      blacklistedApps: this.getBlacklistedApps(),
      lockedPrimary: this.lockedPrimary,
      reordering: this.reordering,
      primaryOutOfOrder: this.primaryOutOfOrder(instances),
      error: this.lastError
    }
  }

  private isLockedInstance(process: ProcessInfo | null): boolean {
    return (
      this.lockedPrimary !== null &&
      process?.executable != null &&
      process.executable === this.lockedPrimary
    )
  }

  private primaryOutOfOrder(instances: RelayInstance[]): boolean {
    if (this.lockedPrimary === null) return false
    const locked = instances.find((inst) => inst.locked)
    return locked !== undefined && !locked.isPrimary
  }

  setMirrorEnabled(index: number, enabled: boolean): RelayStatus {
    if (index === this.primaryIndex()) return this.getStatus()

    if (enabled) {
      this.disabledMirrors.delete(index)
    } else {
      this.disabledMirrors.add(index)
      this.clearMirrorActivity(index)
    }
    this.emitStatus()
    return this.getStatus()
  }

  getDisabledMirrors(): number[] {
    return [...this.disabledMirrors]
  }

  setDisabledMirrors(indices: number[]): void {
    this.disabledMirrors = new Set(indices)
  }

  getLockedPrimary(): string | null {
    return this.lockedPrimary
  }

  setLockedPrimary(executable: string | null): void {
    this.lockedPrimary = executable
    this.emitStatus()
  }

  unlockPrimary(): RelayStatus {
    this.lockedPrimary = null
    this.emitStatus()
    return this.getStatus()
  }

  async promoteToPrimary(index: number): Promise<RelayStatus> {
    const process = platform.getInstanceProcess(index)
    if (!process?.executable) {
      this.lastError = 'Cannot resolve this Discord’s executable path'
      this.emitStatus()
      return this.getStatus()
    }
    this.lockedPrimary = process.executable
    this.emitStatus()
    return this.reorderForPrimary()
  }

  getBlacklistedApps(): BlacklistedApp[] {
    return [...this.blacklistedApps].map(([id, name]) => ({ id, name }))
  }

  setBlacklistedApps(apps: BlacklistedApp[]): void {
    this.blacklistedApps = new Map(apps.map((a) => [a.id, a.name]))
  }

  setAppBlacklisted(appId: string, blacklisted: boolean): RelayStatus {
    if (blacklisted) {
      const session = [...this.sessions.values()].find((s) => s.appId === appId)
      const name = session?.activity?.app ?? session?.process?.name ?? null
      this.blacklistedApps.set(appId, name ?? this.blacklistedApps.get(appId) ?? null)
    } else {
      this.blacklistedApps.delete(appId)
    }

    for (const session of this.sessions.values()) {
      if (session.appId !== appId) continue
      if (blacklisted) {
        this.clearSessionMirrors(session)
      } else if (session.lastActivityPayload) {
        for (let i = 1; i < this.claimed.length; i++) {
          const target = this.claimed[i]
          if (this.disabledMirrors.has(target.index)) continue
          if (this.ensureMirror(session, target)) {
            session.mirrors.get(target.index)?.sendActivity(session.lastActivityPayload)
          }
        }
      }
    }

    this.emitStatus()
    return this.getStatus()
  }

  private isBlacklisted(session: ClientSession): boolean {
    return session.appId !== null && this.blacklistedApps.has(session.appId)
  }

  private clearSessionMirrors(session: ClientSession): void {
    for (const timer of session.reconnectTimers.values()) clearTimeout(timer)
    session.reconnectTimers.clear()

    for (const mirror of session.mirrors.values()) {
      if (session.lastActivityPid !== null) {
        mirror.sendActivityAndClose(clearActivityPayload(session.lastActivityPid))
      } else {
        mirror.destroy()
      }
    }
    session.mirrors.clear()
  }

  async start(): Promise<void> {
    if (this.running) return
    this.lastError = null

    if (!platform.isSupported) {
      this.lastError = 'This platform is not supported'
      this.emitStatus()
      throw new Error(this.lastError)
    }

    await platform.recoverLeftoverSockets()
    const claimed = await platform.discoverAndClaim()

    if (claimed.length === 0) {
      this.waitForDiscord()
      return
    }

    this.claimed = claimed
    this.waiting = false
    this.stopWaitingTimer()

    try {
      const fake = platform.fakeSocketPath()
      platform.removeFakeSocket(fake)

      this.server = net.createServer((sock) => this.handleClient(sock))
      this.server.on('error', (err) => {
        this.lastError = err.message
        this.emitStatus()
      })

      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject)
        this.server!.listen(fake, () => {
          this.server!.removeListener('error', reject)
          resolve()
        })
      })

      platform.finalizeFakeSocket(fake)
      this.fakeOwned = true
    } catch (err) {
      this.server?.close()
      this.server = null
      for (const c of this.claimed) platform.restoreSocket(c)
      this.claimed = []
      this.lastError = err instanceof Error ? err.message : String(err)
      this.emitStatus()
      throw err
    }

    this.running = true
    this.startDiscoveryTimer()
    this.emitStatus()
  }

  async stop(): Promise<void> {
    this.stopWaitingTimer()
    this.waiting = false

    if (!this.running) {
      this.emitStatus()
      return
    }
    this.running = false
    this.stopDiscoveryTimer()

    for (const session of [...this.sessions.values()]) this.destroySession(session)

    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, SERVER_CLOSE_TIMEOUT_MS)
        server.close(() => {
          clearTimeout(timeout)
          resolve()
        })
      })
    }

    platform.removeFakeSocket(platform.fakeSocketPath())
    this.fakeOwned = false
    for (const claimed of this.claimed) platform.restoreSocket(claimed)

    this.claimed = []
    this.emitStatus()
  }

  emergencyRestoreSync(): void {
    try {
      if (this.fakeOwned) {
        platform.removeFakeSocket(platform.fakeSocketPath())
        this.fakeOwned = false
      }
    } catch {
      // Best effort.
    }
    for (const claimed of this.claimed) platform.restoreSocket(claimed)
    this.claimed = []
  }

  private primaryIndex(): number | undefined {
    return this.claimed[0]?.index
  }

  private waitForDiscord(): void {
    this.waiting = true
    this.lastError = null
    this.emitStatus()

    if (this.waitingTimer) return
    this.waitingTimer = setInterval(() => {
      if (!this.waiting) return
      void this.start().catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err)
        this.emitStatus()
      })
    }, WAITING_RETRY_INTERVAL_MS)
  }

  private stopWaitingTimer(): void {
    if (this.waitingTimer) {
      clearInterval(this.waitingTimer)
      this.waitingTimer = null
    }
  }

  private startDiscoveryTimer(): void {
    this.stopDiscoveryTimer()
    this.discoveryTimer = setInterval(() => void this.discoverInstances(), DISCOVERY_INTERVAL_MS)
  }

  private stopDiscoveryTimer(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer)
      this.discoveryTimer = null
    }
  }

  /** Periodic: recover stolen primary, prune dead instances, discover new ones. */
  private async discoverInstances(): Promise<void> {
    if (!this.running || this.discovering) return
    this.discovering = true
    try {
      if (!platform.fakeSocketExists(platform.fakeSocketPath())) {
        void this.restart()
        return
      }

      let changed = false

      for (const claimed of [...this.claimed]) {
        if (await platform.isSocketAlive(claimed.path)) continue
        if (!this.running) return

        if (claimed === this.claimed[0]) {
          void this.restart()
          return
        }

        this.claimed = this.claimed.filter((c) => c !== claimed)
        platform.discardClaimedSocket(claimed)
        for (const session of this.sessions.values()) {
          this.dropSessionMirror(session, claimed.index)
        }
        changed = true
      }

      const claimedIndices = new Set(this.claimed.map((c) => c.index))
      for (let i = 1; i < MAX_SOCKETS; i++) {
        if (claimedIndices.has(i)) continue
        const found = await platform.discoverNewSocket(i)
        if (!found) continue
        if (!this.running) {
          platform.restoreSocket(found)
          return
        }

        this.claimed.push(found)
        changed = true

        if (!this.disabledMirrors.has(found.index)) {
          for (const session of this.sessions.values()) {
            if (this.isBlacklisted(session)) continue
            if (this.ensureMirror(session, found) && session.lastActivityPayload) {
              session.mirrors.get(found.index)?.sendActivity(session.lastActivityPayload)
            }
          }
        }
      }

      if (changed) this.emitStatus()
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.emitStatus()
    } finally {
      this.discovering = false
    }
  }

  private handleClient(client: net.Socket): void {
    const primaryClaimed = this.claimed[0]
    if (!primaryClaimed) {
      client.destroy()
      return
    }

    const fd = (client as unknown as { _handle?: { fd?: number } })._handle?.fd
    const session: ClientSession = {
      id: this.nextClientId++,
      client,
      primary: net.createConnection(primaryClaimed.path),
      process: fd !== undefined ? platform.getPeerProcess(fd) : null,
      handshakePayload: null,
      appId: null,
      lastActivityPayload: null,
      lastActivityPid: null,
      activity: null,
      mirrors: new Map(),
      reconnectTimers: new Map(),
      closed: false
    }
    this.sessions.set(session.id, session)
    this.emitStatus()

    const { primary } = session
    const clientReader = new FrameReader()
    const primaryReader = new FrameReader()

    let primaryConnected = false
    const pendingToPrimary: Buffer[] = []

    client.on('data', (chunk: Buffer) => {
      for (const frame of clientReader.push(chunk)) {
        if (frame.op === OP_HANDSHAKE) {
          session.handshakePayload = frame.payload
          session.appId = (parseFramePayload(frame)?.client_id as string) ?? null
        }

        const encoded = encodeFrame(frame.op, frame.payload)
        if (primaryConnected && primary.writable) {
          primary.write(encoded)
        } else {
          pendingToPrimary.push(encoded)
        }

        if (session.handshakePayload) this.mirrorFrame(session, frame)
        void this.recordActivity(session, frame)
      }
    })

    primary.on('connect', () => {
      primaryConnected = true
      for (const encoded of pendingToPrimary.splice(0)) primary.write(encoded)

      primary.on('data', (chunk: Buffer) => {
        for (const frame of primaryReader.push(chunk)) {
          if (client.writable) client.write(encodeFrame(frame.op, frame.payload))
        }
      })
    })

    const cleanup = (): void => this.destroySession(session)

    client.on('error', cleanup)
    client.on('close', cleanup)
    primary.on('close', cleanup)
    primary.on('error', (err) => {
      cleanup()
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ENOENT') {
        void this.restart()
      } else {
        this.lastError = `Primary connection error: ${err.message}`
        this.emitStatus()
      }
    })
  }

  private destroySession(session: ClientSession): void {
    if (session.closed) return
    session.closed = true

    session.client.destroy()
    session.primary.destroy()
    for (const timer of session.reconnectTimers.values()) clearTimeout(timer)
    session.reconnectTimers.clear()
    for (const mirror of session.mirrors.values()) mirror.destroy()
    session.mirrors.clear()

    this.sessions.delete(session.id)
    this.emitStatus()
  }

  private dropSessionMirror(session: ClientSession, index: number): void {
    const timer = session.reconnectTimers.get(index)
    if (timer) {
      clearTimeout(timer)
      session.reconnectTimers.delete(index)
    }
    session.mirrors.get(index)?.destroy()
    session.mirrors.delete(index)
  }

  private async restart(): Promise<void> {
    if (this.restarting) return
    this.restarting = true
    try {
      await this.stop()
      await this.start()
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.emitStatus()
    } finally {
      this.restarting = false
    }
  }

  private async reorderForPrimary(): Promise<RelayStatus> {
    if (this.reordering) return this.getStatus()
    if (this.lockedPrimary === null) return this.getStatus()

    const lockedSlot = this.claimed.findIndex(
      (c) => platform.getInstanceProcess(c.index)?.executable === this.lockedPrimary
    )
    if (lockedSlot < 0) {
      this.lastError = 'Locked Discord is not currently running'
      this.emitStatus()
      return this.getStatus()
    }
    if (lockedSlot === 0) return this.getStatus()

    this.reordering = true
    this.lastError = null
    this.emitStatus()

    try {
      // Grab what we need now before stop() wipes claimed below.
      const others: string[] = []
      const toKill: number[] = []
      const freeIndices: number[] = []
      for (let i = 0; i <= lockedSlot; i++) {
        freeIndices.push(this.claimed[i].index)
        const proc = platform.getInstanceProcess(this.claimed[i].index)
        if (!proc) continue
        toKill.push(proc.pid)
        if (proc.executable && proc.executable !== this.lockedPrimary) {
          others.push(proc.executable)
        }
      }
      const lockedExecutable = this.lockedPrimary

      await this.stop()

      for (const pid of toKill) platform.killProcess(pid)
      await this.waitForProcessesExit(toKill)

      for (const index of freeIndices) {
        await platform.removeStaleIpcSocket(index)
      }

      if (!platform.launchExecutable(lockedExecutable)) {
        throw new Error('Failed to relaunch the locked Discord')
      }
      await this.waitForSlotBound(0)

      for (const executable of others) platform.launchExecutable(executable)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
    } finally {
      this.reordering = false
      await this.start().catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err)
      })
      this.emitStatus()
    }

    return this.getStatus()
  }

  private async waitForProcessesExit(pids: number[]): Promise<void> {
    const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (pids.every((pid) => !platform.isProcessAlive(pid))) return
      await delay(PROCESS_EXIT_POLL_MS)
    }
  }

  private async waitForSlotBound(index: number): Promise<void> {
    const deadline = Date.now() + SLOT_BIND_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await platform.isSocketAlive(platform.ipcSocketPath(index))) return
      await delay(SLOT_BIND_POLL_MS)
    }
    throw new Error('Timed out waiting for the locked Discord to start')
  }

  private mirrorFrame(session: ClientSession, frame: Frame): void {
    const payload = frame.op !== OP_HANDSHAKE ? parseFramePayload(frame) : null
    const isSetActivity = payload?.cmd === 'SET_ACTIVITY'
    if (frame.op !== OP_HANDSHAKE && !isSetActivity) return

    if (isSetActivity) {
      session.lastActivityPayload = frame.payload
      const pid = (payload!.args as { pid?: number } | undefined)?.pid
      if (typeof pid === 'number') session.lastActivityPid = pid
    }

    if (this.isBlacklisted(session)) return

    for (let i = 1; i < this.claimed.length; i++) {
      const { index } = this.claimed[i]

      if (this.disabledMirrors.has(index)) {
        this.dropSessionMirror(session, index)
        continue
      }

      this.ensureMirror(session, this.claimed[i])
      if (frame.op !== OP_HANDSHAKE) session.mirrors.get(index)?.sendActivity(frame.payload)
    }
  }

  private ensureMirror(session: ClientSession, target: ClaimedSocket): boolean {
    if (session.closed || !session.handshakePayload) return false
    if (session.mirrors.has(target.index)) return false

    const mirror: MirrorConnection = new MirrorConnection(
      target.path,
      session.handshakePayload,
      () => {
        if (session.mirrors.get(target.index) === mirror) {
          session.mirrors.delete(target.index)
          this.scheduleMirrorReconnect(session, target.index)
        }
      }
    )
    session.mirrors.set(target.index, mirror)
    return true
  }

  private scheduleMirrorReconnect(session: ClientSession, index: number): void {
    if (session.closed || !this.running) return
    if (session.reconnectTimers.has(index)) return

    const timer = setTimeout(() => {
      session.reconnectTimers.delete(index)
      if (session.closed || !this.running) return
      if (this.disabledMirrors.has(index) || this.isBlacklisted(session)) return
      if (!session.lastActivityPayload) return

      const target = this.claimed.find((c, i) => i > 0 && c.index === index)
      if (!target) return

      if (this.ensureMirror(session, target)) {
        session.mirrors.get(index)?.sendActivity(session.lastActivityPayload)
      }
    }, MIRROR_RECONNECT_DELAY_MS)
    session.reconnectTimers.set(index, timer)
  }

  private clearMirrorActivity(index: number): void {
    for (const session of this.sessions.values()) {
      const timer = session.reconnectTimers.get(index)
      if (timer) {
        clearTimeout(timer)
        session.reconnectTimers.delete(index)
      }

      const mirror = session.mirrors.get(index)
      if (!mirror) continue

      if (session.lastActivityPid !== null) {
        mirror.sendActivityAndClose(clearActivityPayload(session.lastActivityPid))
      } else {
        mirror.destroy()
      }

      session.mirrors.delete(index)
    }
  }

  private async recordActivity(session: ClientSession, frame: Frame): Promise<void> {
    if (frame.op === OP_HANDSHAKE) return

    const data = parseFramePayload(frame)
    if (data?.cmd !== 'SET_ACTIVITY') return

    const at = Date.now()
    const appId = session.appId
    const activity = (data.args as { activity?: Record<string, unknown> | null })?.activity

    if (!activity) {
      session.activity = null
      this.emitStatus()
      return
    }

    const rawAssets = activity.assets as Record<string, string> | undefined
    const assets: ActivityAssets | null = rawAssets
      ? {
          largeImage: await resolveAssetImage(rawAssets.large_image, appId),
          largeText: rawAssets.large_text ?? null,
          smallImage: await resolveAssetImage(rawAssets.small_image, appId),
          smallText: rawAssets.small_text ?? null
        }
      : null

    const rawTimestamps = activity.timestamps as Record<string, number> | undefined
    const timestamps: ActivityTimestamps | null = rawTimestamps
      ? {
          start: rawTimestamps.start ?? null,
          end: rawTimestamps.end ?? null
        }
      : null

    const rawButtons = activity.buttons as Array<{ label: string; url: string }> | undefined
    const buttons: ActivityButton[] = Array.isArray(rawButtons)
      ? rawButtons.map((b) => ({ label: b.label, url: b.url }))
      : []

    // Prevent stale network-delayed frames from overwriting newer ones.
    if (session.closed) return
    if (session.activity && session.activity.at > at) return

    session.activity = {
      app: (activity.name as string) ?? null,
      details: (activity.details as string) ?? null,
      state: (activity.state as string) ?? null,
      assets,
      timestamps,
      buttons,
      at
    }
    this.emitStatus()
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }
}

export const relay = new RpcRelay()
