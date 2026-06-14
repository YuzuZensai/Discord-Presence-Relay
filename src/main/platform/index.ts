import { PosixPlatform } from './posix'
import { UnsupportedPlatform } from './unsupported'
import type { RelayPlatform } from './types'

export type { ClaimedSocket, ProcessInfo, RelayPlatform } from './types'

export const platform: RelayPlatform =
  process.platform === 'win32' ? new UnsupportedPlatform() : new PosixPlatform()
