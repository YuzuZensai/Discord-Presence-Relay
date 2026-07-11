import * as net from 'net'
import { encodeFrame, FrameReader, OP_FRAME, OP_HANDSHAKE } from './ipc-protocol'

const READY_TIMEOUT_MS = 10_000

export class MirrorConnection {
  private readonly sock: net.Socket
  private readonly reader = new FrameReader()
  private ready = false
  private pending: Buffer[] = []
  private closeAfterPending = false

  constructor(socketPath: string, handshakePayload: Buffer, onClose: () => void) {
    this.sock = net.createConnection(socketPath)

    const readyTimeout = setTimeout(() => this.sock.destroy(), READY_TIMEOUT_MS)
    readyTimeout.unref()

    this.sock.on('connect', () => {
      this.sock.write(encodeFrame(OP_HANDSHAKE, handshakePayload))
    })

    this.sock.on('data', (chunk: Buffer) => {
      const hadFrames = this.reader.push(chunk).length > 0
      if (hadFrames && !this.ready) {
        this.ready = true
        clearTimeout(readyTimeout)
        for (const frame of this.pending.splice(0)) this.sock.write(frame)
        if (this.closeAfterPending) this.sock.end()
      }
    })

    this.sock.on('error', () => {})
    this.sock.on('close', () => {
      clearTimeout(readyTimeout)
      onClose()
    })
  }

  sendActivity(payload: Buffer): void {
    const frame = encodeFrame(OP_FRAME, payload)
    if (this.ready) {
      if (this.sock.writable) this.sock.write(frame)
    } else {
      this.pending.push(frame)
    }
  }

  sendActivityAndClose(payload: Buffer): void {
    const frame = encodeFrame(OP_FRAME, payload)
    if (this.ready) {
      if (this.sock.writable) this.sock.end(frame)
      else this.sock.destroy()
    } else {
      this.pending.push(frame)
      this.closeAfterPending = true
    }
  }

  destroy(): void {
    this.sock.destroy()
  }
}
