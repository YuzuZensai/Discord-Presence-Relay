import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import type { ClaimedSocket, ProcessInfo, RelayPlatform } from './types'

const REAL_PREFIX = 'discord-ipc-real-'
const FAKE_INDEX = 0
const MAX_SOCKETS = 10

function runtimeDir(): string {
  if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR
  if (process.platform === 'darwin') return process.env.TMPDIR ?? '/tmp'
  return `/run/user/${process.getuid?.() ?? 0}`
}

function ipcPath(index: number): string {
  return path.join(runtimeDir(), `discord-ipc-${index}`)
}

function claimedPath(index: number): string {
  return path.join(runtimeDir(), `${REAL_PREFIX}${index}`)
}

/**
 * Linux + macOS implementation. Discord listens on Unix domain sockets named
 * discord-ipc-0..9 in the runtime directory. We take over index 0 by renaming
 * the real socket out of the way and binding our own server in its place,
 * connecting through to the renamed socket for passthrough.
 */
export class PosixPlatform implements RelayPlatform {
  readonly isSupported = true

  fakeSocketPath(): string {
    return ipcPath(FAKE_INDEX)
  }

  removeFakeSocket(fakePath: string): void {
    if (fs.existsSync(fakePath)) fs.unlinkSync(fakePath)
  }

  finalizeFakeSocket(fakePath: string): void {
    fs.chmodSync(fakePath, 0o777)
  }

  fakeSocketExists(fakePath: string): boolean {
    return fs.existsSync(fakePath)
  }

  async recoverLeftoverSockets(): Promise<void> {
    for (let i = 0; i < MAX_SOCKETS; i++) {
      const leftover = claimedPath(i)
      const original = ipcPath(i)
      if (!fs.existsSync(leftover)) continue

      if (!fs.existsSync(original)) {
        fs.renameSync(leftover, original)
        continue
      }

      // The original path may be a dead fake socket left behind by a
      // relay process that died without cleaning up. If nothing is
      // listening there, remove it and restore the real socket.
      if (!(await isSocketAlive(original))) {
        fs.unlinkSync(original)
        fs.renameSync(leftover, original)
      }
    }
  }

  discoverAndClaim(): ClaimedSocket[] {
    const found: ClaimedSocket[] = []
    for (let i = 0; i < MAX_SOCKETS; i++) {
      const claimed = this.discoverNewSocket(i)
      if (claimed) found.push(claimed)
    }
    return found
  }

  discoverNewSocket(index: number): ClaimedSocket | null {
    const src = ipcPath(index)
    if (!fs.existsSync(src)) return null

    const dst = claimedPath(index)
    fs.renameSync(src, dst)
    return { index, path: dst }
  }

  restoreSocket(claimed: ClaimedSocket): void {
    const original = ipcPath(claimed.index)
    if (fs.existsSync(claimed.path) && !fs.existsSync(original)) {
      fs.renameSync(claimed.path, original)
    }
  }

  getInstanceProcess(index: number): ProcessInfo | null {
    // The kernel reports a Unix socket's *original* bind path in
    // /proc/net/unix even after the file is renamed on disk, so look up
    // owners by the pre-rename discord-ipc-N path rather than the claimed one.
    return findSocketOwner(ipcPath(index))
  }

  getPeerProcess(fd: number): ProcessInfo | null {
    return findPeerProcess(fd)
  }
}

function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath)
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
  })
}

const SOCKET_OWNER_CACHE_MS = 2000
const socketOwnerCache = new Map<string, { value: ProcessInfo | null; at: number }>()

/**
 * Identifies the process listening on a Unix socket file by cross-referencing
 * /proc/net/unix (path -> inode) with /proc/*\/fd (inode -> pid). Linux only;
 * results are cached briefly since this scans every process's open fds.
 */
function findSocketOwner(socketPath: string): ProcessInfo | null {
  if (process.platform !== 'linux') return null

  const cached = socketOwnerCache.get(socketPath)
  if (cached && Date.now() - cached.at < SOCKET_OWNER_CACHE_MS) {
    return cached.value
  }

  const result = locateSocketOwner(socketPath)
  socketOwnerCache.set(socketPath, { value: result, at: Date.now() })
  return result
}

function locateSocketOwner(socketPath: string): ProcessInfo | null {
  // Multiple sockets can be bound to the same path (our own fake server
  // shares discord-ipc-0's path with the real Discord socket after rename),
  // so check every matching inode and skip the one owned by this process.
  for (const inode of findInodesForPath(socketPath)) {
    const owner = findProcessForInode(inode)
    if (owner && owner.pid !== process.pid) return owner
  }
  return null
}

function findInodesForPath(socketPath: string): string[] {
  const inodes: string[] = []
  try {
    const unixTable = fs.readFileSync('/proc/net/unix', 'utf8')
    for (const line of unixTable.split('\n')) {
      if (line.endsWith(` ${socketPath}`)) {
        inodes.push(line.trim().split(/\s+/)[6])
      }
    }
  } catch {
    return inodes
  }
  return inodes
}

function findProcessForInode(inode: string): ProcessInfo | null {
  return findProcessForInodes(new Set([inode]))
}

function findProcessForInodes(inodes: Set<string>): ProcessInfo | null {
  try {
    for (const pidStr of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pidStr)) continue
      if (parseInt(pidStr, 10) === process.pid) continue

      const fdDir = `/proc/${pidStr}/fd`
      let fds: string[]
      try {
        fds = fs.readdirSync(fdDir)
      } catch {
        continue
      }

      for (const fd of fds) {
        let link: string
        try {
          link = fs.readlinkSync(path.join(fdDir, fd))
        } catch {
          continue
        }
        const match = /^socket:\[(\d+)\]$/.exec(link)
        if (match && inodes.has(match[1])) {
          return { pid: parseInt(pidStr, 10), name: processName(pidStr) }
        }
      }
    }
  } catch {
    return null
  }
  return null
}

function processName(pidStr: string): string {
  try {
    return fs.readFileSync(`/proc/${pidStr}/comm`, 'utf8').trim()
  } catch {
    return pidStr
  }
}

interface GetSockOpt {
  (sockfd: number, level: number, optname: number, optval: Buffer, optlen: Buffer): number
}

let getsockopt: GetSockOpt | null | undefined

function loadGetSockOpt(): GetSockOpt | null {
  if (getsockopt !== undefined) return getsockopt

  if (process.platform !== 'linux') {
    getsockopt = null
    return getsockopt
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const libc = koffi.load('libc.so.6')
    getsockopt = libc.func(
      'int getsockopt(int sockfd, int level, int optname, void *optval, int *optlen)'
    ) as GetSockOpt
  } catch {
    getsockopt = null
  }
  return getsockopt
}

const SOL_SOCKET = 1
const SO_PEERCRED = 17
const UCRED_SIZE = 12 // struct ucred { pid_t pid; uid_t uid; gid_t gid; }

function findPeerProcess(localFd: number): ProcessInfo | null {
  const fn = loadGetSockOpt()
  if (!fn) return null

  const optval = Buffer.alloc(UCRED_SIZE)
  const optlen = Buffer.alloc(4)
  optlen.writeInt32LE(UCRED_SIZE, 0)

  if (fn(localFd, SOL_SOCKET, SO_PEERCRED, optval, optlen) !== 0) return null

  const pid = optval.readInt32LE(0)
  if (pid <= 0) return null

  return { pid, name: processName(String(pid)) }
}
