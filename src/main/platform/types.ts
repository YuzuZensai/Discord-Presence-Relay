export const MAX_SOCKETS = 10

export interface ProcessInfo {
  pid: number
  name: string
  executable: string | null
}

export interface ClaimedSocket {
  index: number
  path: string
}

export interface RelayPlatform {
  readonly isSupported: boolean

  fakeSocketPath(): string

  ipcSocketPath(index: number): string

  removeFakeSocket(fakePath: string): void

  finalizeFakeSocket(fakePath: string): void

  /** Checks whether Discord has unlinked our fake socket. */
  fakeSocketExists(fakePath: string): boolean

  recoverLeftoverSockets(): Promise<void>

  discoverAndClaim(): Promise<ClaimedSocket[]>

  discoverNewSocket(index: number): Promise<ClaimedSocket | null>

  restoreSocket(claimed: ClaimedSocket): void

  discardClaimedSocket(claimed: ClaimedSocket): void

  isSocketAlive(socketPath: string): Promise<boolean>

  removeStaleIpcSocket(index: number): Promise<void>

  getInstanceProcess(index: number): ProcessInfo | null

  getPeerProcess(fd: number): ProcessInfo | null

  killProcess(pid: number): boolean

  isProcessAlive(pid: number): boolean

  launchExecutable(executable: string): boolean
}
