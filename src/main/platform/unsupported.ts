import type { ClaimedSocket, ProcessInfo, RelayPlatform } from './types'

const NOT_SUPPORTED = new Error('Platform not supported')

/**
 * Placeholder for platforms without a real implementation yet.
 */
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

  discoverAndClaim(): ClaimedSocket[] {
    throw NOT_SUPPORTED
  }

  discoverNewSocket(): ClaimedSocket | null {
    throw NOT_SUPPORTED
  }

  restoreSocket(): void {
    throw NOT_SUPPORTED
  }

  getInstanceProcess(): ProcessInfo | null {
    return null
  }

  getPeerProcess(): ProcessInfo | null {
    return null
  }
}
