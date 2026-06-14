export interface ProcessInfo {
  pid: number
  name: string
}

export interface ClaimedSocket {
  index: number
  path: string
}

/**
 * Platform-specific primitives the relay needs to take over Discord's IPC
 * sockets and identify the processes on either end of a connection.
 *
 * Implement this interface to add support for a new OS; `RpcRelay` itself
 * contains no platform-specific code.
 */
export interface RelayPlatform {
  readonly isSupported: boolean

  fakeSocketPath(): string

  removeFakeSocket(fakePath: string): void

  finalizeFakeSocket(fakePath: string): void

  /** Checks whether the fake socket file still exists on disk (a restarted Discord client can unlink and rebind it out from under us). */
  fakeSocketExists(fakePath: string): boolean

  /**
   * Restores sockets left claimed from a previous run that crashed before
   * it could call restoreSocket(), so a fresh start() can discover them.
   */
  recoverLeftoverSockets(): Promise<void>

  discoverAndClaim(): ClaimedSocket[]

  discoverNewSocket(index: number): ClaimedSocket | null

  restoreSocket(claimed: ClaimedSocket): void

  getInstanceProcess(index: number): ProcessInfo | null

  getPeerProcess(fd: number): ProcessInfo | null
}
