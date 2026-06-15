import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import * as net from 'net'
import { encodeFrame, Frame, FrameReader, OP_HANDSHAKE, parseFramePayload } from './ipc-protocol'
import { MirrorConnection } from './mirror-connection'
import { platform, type ClaimedSocket, type ProcessInfo } from './platform'

const MAX_SOCKETS = 10
const DISCOVERY_INTERVAL_MS = 3000

interface AppAsset {
  id: string
  type: number
  name: string
}

const appAssetCache = new Map<string, Map<string, string>>()

async function getAppAssetMap(appId: string): Promise<Map<string, string>> {
  const cached = appAssetCache.get(appId)
  if (cached) return cached

  const map = new Map<string, string>()
  try {
    const res = await fetch(`https://discord.com/api/v9/oauth2/applications/${appId}/assets`)
    if (res.ok) {
      const assets = (await res.json()) as AppAsset[]
      for (const asset of assets) map.set(asset.name, asset.id)
    }
  } catch {
    // Network error: cache an empty map so we don't retry every frame.
  }

  appAssetCache.set(appId, map)
  return map
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
  process: ProcessInfo | null
}

export interface ConnectedClient {
  id: number
  process: ProcessInfo | null
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
  unsupported: boolean
  instances: RelayInstance[]
  connectedClients: ConnectedClient[]
  lastActivity: LastActivity | null
  error: string | null
}

/**
 * Takes over Discord's primary IPC socket (discord-ipc-0), passing every
 * frame through to the real primary instance unchanged, while mirroring the
 * handshake and SET_ACTIVITY frames to any other running Discord instances.
 */
export class RpcRelay extends EventEmitter {
  private server: net.Server | null = null
  private claimed: ClaimedSocket[] = []
  private disabledMirrors = new Set<number>()
  private connectedClients = new Map<number, ConnectedClient>()
  private nextClientId = 1
  private discoveryTimer: NodeJS.Timeout | null = null
  private lastActivity: LastActivity | null = null
  private running = false
  private lastError: string | null = null
  private restarting = false
  private mirrors = new Map<number, MirrorConnection>()
  private lastActivityPid = new Map<number, number>()

  getStatus(): RelayStatus {
    const instances: RelayInstance[] = this.claimed.map(({ index, path: socketPath }, i) => ({
      index,
      path: socketPath,
      isPrimary: i === 0,
      enabled: i === 0 || !this.disabledMirrors.has(index),
      process: platform.getInstanceProcess(index)
    }))

    return {
      running: this.running,
      unsupported: !platform.isSupported,
      instances,
      connectedClients: [...this.connectedClients.values()],
      lastActivity: this.lastActivity,
      error: this.lastError
    }
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

  async start(): Promise<void> {
    if (this.running) return
    this.lastError = null

    if (!platform.isSupported) {
      this.lastError = 'This platform is not supported'
      this.emitStatus()
      throw new Error(this.lastError)
    }

    await platform.recoverLeftoverSockets()
    this.claimed = platform.discoverAndClaim()

    if (this.claimed.length === 0) {
      this.lastError = 'No running Discord clients found (no discord-ipc-N sockets)'
      this.emitStatus()
      throw new Error(this.lastError)
    }

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

    this.running = true
    this.startDiscoveryTimer()
    this.emitStatus()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.stopDiscoveryTimer()

    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = null
    }

    platform.removeFakeSocket(platform.fakeSocketPath())
    for (const claimed of this.claimed) platform.restoreSocket(claimed)

    for (const mirror of this.mirrors.values()) mirror.destroy()
    this.mirrors.clear()
    this.lastActivityPid.clear()

    this.claimed = []
    this.connectedClients.clear()
    this.emitStatus()
  }

  private primaryIndex(): number | undefined {
    return this.claimed[0]?.index
  }

  private startDiscoveryTimer(): void {
    this.stopDiscoveryTimer()
    this.discoveryTimer = setInterval(() => this.discoverNewInstances(), DISCOVERY_INTERVAL_MS)
  }

  private stopDiscoveryTimer(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer)
      this.discoveryTimer = null
    }
  }

  /** Picks up Discord instances launched after the relay started, and recovers from a stolen primary socket. */
  private discoverNewInstances(): void {
    if (!this.running) return

    if (!platform.fakeSocketExists(platform.fakeSocketPath())) {
      void this.restart()
      return
    }

    const claimedIndices = new Set(this.claimed.map((c) => c.index))
    let changed = false

    for (let i = 1; i < MAX_SOCKETS; i++) {
      if (claimedIndices.has(i)) continue
      const found = platform.discoverNewSocket(i)
      if (found) {
        this.claimed.push(found)
        changed = true
      }
    }

    if (changed) this.emitStatus()
  }

  private handleClient(client: net.Socket): void {
    const clientId = this.nextClientId++
    const fd = (client as unknown as { _handle?: { fd?: number } })._handle?.fd
    this.connectedClients.set(clientId, {
      id: clientId,
      process: fd !== undefined ? platform.getPeerProcess(fd) : null
    })
    this.emitStatus()

    const primaryPath = this.claimed[0].path
    const primary = net.createConnection(primaryPath)

    const clientReader = new FrameReader()
    const primaryReader = new FrameReader()

    let handshakePayload: Buffer | null = null

    const cleanup = (): void => {
      client.destroy()
      primary.destroy()
      for (const mirror of this.mirrors.values()) mirror.destroy()
      this.mirrors.clear()
      this.lastActivityPid.clear()
      this.connectedClients.delete(clientId)
      this.emitStatus()
    }

    let clientAppId: string | null = null
    let primaryConnected = false
    const pendingToPrimary: Buffer[] = []

    client.on('data', (chunk) => {
      for (const frame of clientReader.push(chunk)) {
        if (frame.op === OP_HANDSHAKE) {
          handshakePayload = frame.payload
          clientAppId = (parseFramePayload(frame)?.client_id as string) ?? null
        }

        const encoded = encodeFrame(frame.op, frame.payload)
        if (primaryConnected && primary.writable) {
          primary.write(encoded)
        } else {
          pendingToPrimary.push(encoded)
        }

        if (handshakePayload) this.mirrorFrame(frame, handshakePayload)
        void this.recordActivity(frame, clientAppId)
      }
    })

    primary.on('connect', () => {
      primaryConnected = true
      for (const encoded of pendingToPrimary.splice(0)) primary.write(encoded)

      primary.on('data', (chunk) => {
        for (const frame of primaryReader.push(chunk)) {
          if (client.writable) client.write(encodeFrame(frame.op, frame.payload))
        }
      })
    })

    client.on('error', cleanup)
    primary.on('error', (err) => {
      cleanup()
      if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        void this.restart()
      } else {
        this.lastError = `Primary connection error: ${err.message}`
        this.emitStatus()
      }
    })
    client.on('close', cleanup)
    primary.on('close', cleanup)
  }

  /** Restarts the relay, picking up any Discord instance that has replaced its IPC socket. */
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

  /** Forwards the handshake and SET_ACTIVITY frames to every enabled mirror instance. */
  private mirrorFrame(frame: Frame, handshakePayload: Buffer): void {
    const payload = frame.op !== OP_HANDSHAKE ? parseFramePayload(frame) : null
    const isSetActivity = payload?.cmd === 'SET_ACTIVITY'
    if (frame.op !== OP_HANDSHAKE && !isSetActivity) return

    if (isSetActivity) {
      const pid = (payload!.args as { pid?: number } | undefined)?.pid
      if (typeof pid === 'number') {
        for (let i = 1; i < this.claimed.length; i++) {
          this.lastActivityPid.set(this.claimed[i].index, pid)
        }
      }
    }

    for (let i = 1; i < this.claimed.length; i++) {
      const { index, path: mirrorPath } = this.claimed[i]

      if (this.disabledMirrors.has(index)) {
        this.mirrors.get(index)?.destroy()
        this.mirrors.delete(index)
        continue
      }

      let mirror = this.mirrors.get(index)
      if (!mirror) {
        const newMirror: MirrorConnection = new MirrorConnection(
          mirrorPath,
          handshakePayload,
          () => {
            if (this.mirrors.get(index) === newMirror) this.mirrors.delete(index)
          }
        )
        mirror = newMirror
        this.mirrors.set(index, mirror)
        if (frame.op === OP_HANDSHAKE) continue // handshake already sent on connect
      }

      if (frame.op !== OP_HANDSHAKE) mirror.sendActivity(frame.payload)
    }
  }

  /** Sends a SET_ACTIVITY frame clearing the presence on a mirror, then disconnects it. */
  private clearMirrorActivity(index: number): void {
    const mirror = this.mirrors.get(index)
    if (!mirror) return

    const pid = this.lastActivityPid.get(index)
    if (pid !== undefined) {
      const clearPayload = Buffer.from(
        JSON.stringify({
          cmd: 'SET_ACTIVITY',
          args: { pid, activity: null },
          nonce: randomUUID()
        }),
        'utf8'
      )
      mirror.sendActivityAndClose(clearPayload)
    } else {
      mirror.destroy()
    }

    this.mirrors.delete(index)
    this.lastActivityPid.delete(index)
  }

  private async recordActivity(frame: Frame, appId: string | null): Promise<void> {
    if (frame.op === OP_HANDSHAKE) return

    const data = parseFramePayload(frame)
    if (data?.cmd !== 'SET_ACTIVITY') return

    const activity = (data.args as { activity?: Record<string, unknown> })?.activity ?? {}

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

    this.lastActivity = {
      app: (activity.name as string) ?? null,
      details: (activity.details as string) ?? null,
      state: (activity.state as string) ?? null,
      assets,
      timestamps,
      buttons,
      at: Date.now()
    }
    this.emitStatus()
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }
}

export const relay = new RpcRelay()
