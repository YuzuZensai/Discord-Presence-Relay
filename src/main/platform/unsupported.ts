import type { ClaimedSocket, ProcessInfo, RelayPlatform } from './types'

const NOT_SUPPORTED = new Error('Platform not supported')

export class UnsupportedPlatform implements RelayPlatform {
  readonly isSupported = false

  fakeSocketPath(): string {
    throw NOT_SUPPORTED
  }

  removeFakeSocket(): void {
    throw NOT_SUPPORTED
  }

  finalizeFakeSocket(): void {
    throw NOT_SUPPORTED
  }

  fakeSocketExists(): boolean {
    throw NOT_SUPPORTED
  }

  async recoverLeftoverSockets(): Promise<void> {
    throw NOT_SUPPORTED
  }

  async discoverAndClaim(): Promise<ClaimedSocket[]> {
    throw NOT_SUPPORTED
  }

  async discoverNewSocket(): Promise<ClaimedSocket | null> {
    throw NOT_SUPPORTED
  }

  restoreSocket(): void {
    throw NOT_SUPPORTED
  }

  discardClaimedSocket(): void {
    throw NOT_SUPPORTED
  }

  async isSocketAlive(): Promise<boolean> {
    return false
  }

  getInstanceProcess(): ProcessInfo | null {
    return null
  }

  getPeerProcess(): ProcessInfo | null {
    return null
  }
}
