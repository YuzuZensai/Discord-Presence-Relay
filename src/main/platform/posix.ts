import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { execFileSync } from 'child_process'
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
    // /proc/net/unix reports the original bind path even after the file is renamed on disk
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

function findSocketOwner(socketPath: string): ProcessInfo | null {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return null

  const cached = socketOwnerCache.get(socketPath)
  if (cached && Date.now() - cached.at < SOCKET_OWNER_CACHE_MS) {
    return cached.value
  }

  const result =
    process.platform === 'darwin'
      ? locateSocketOwnerMacOS(socketPath)
      : locateSocketOwner(socketPath)
  socketOwnerCache.set(socketPath, { value: result, at: Date.now() })
  return result
}

function locateSocketOwnerMacOS(socketPath: string): ProcessInfo | null {
  try {
    const output = execFileSync('lsof', ['-U', '-F', 'pcn'], { encoding: 'utf8', timeout: 3000 })
    let currentPid = 0
    let currentName = ''
    for (const line of output.split('\n')) {
      if (line.startsWith('p')) {
        currentPid = parseInt(line.slice(1), 10)
        currentName = ''
      } else if (line.startsWith('c')) {
        currentName = line.slice(1)
      } else if (line.startsWith('n') && line.slice(1) === socketPath) {
        if (currentPid > 0 && currentPid !== process.pid) {
          return { pid: currentPid, name: currentName }
        }
      }
    }
  } catch {
    return null
  }
  return null
}

function locateSocketOwner(socketPath: string): ProcessInfo | null {
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

  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    getsockopt = null
    return getsockopt
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const libName = process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6'
    const libc = koffi.load(libName)
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
const UCRED_SIZE = 12
const SOL_LOCAL = 0
const LOCAL_PEERPID = 2

function findPeerProcess(localFd: number): ProcessInfo | null {
  const fn = loadGetSockOpt()
  if (!fn) return null

  if (process.platform === 'darwin') {
    const optval = Buffer.alloc(4)
    const optlen = Buffer.alloc(4)
    optlen.writeInt32LE(4, 0)
    if (fn(localFd, SOL_LOCAL, LOCAL_PEERPID, optval, optlen) !== 0) return null
    const pid = optval.readInt32LE(0)
    if (pid <= 0) return null
    return { pid, name: macProcessName(pid) }
  }

  const optval = Buffer.alloc(UCRED_SIZE)
  const optlen = Buffer.alloc(4)
  optlen.writeInt32LE(UCRED_SIZE, 0)

  if (fn(localFd, SOL_SOCKET, SO_PEERCRED, optval, optlen) !== 0) return null

  const pid = optval.readInt32LE(0)
  if (pid <= 0) return null

  return { pid, name: processName(String(pid)) }
}

function macProcessName(pid: number): string {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      timeout: 1000
    }).trim()
  } catch {
    return String(pid)
  }
}
