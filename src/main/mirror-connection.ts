import * as net from 'net'
import { encodeFrame, FrameReader, OP_FRAME, OP_HANDSHAKE } from './ipc-protocol'

/**
 * A lazily-established connection to a secondary Discord instance that
 * mirrors the primary connection's handshake and SET_ACTIVITY frames.
 */
export class MirrorConnection {
  private readonly sock: net.Socket
  private readonly reader = new FrameReader()
  private ready = false
  private pending: Buffer[] = []
  private closeAfterPending = false

  constructor(socketPath: string, handshakePayload: Buffer, onClose: () => void) {
    this.sock = net.createConnection(socketPath)

    this.sock.on('connect', () => {
      this.sock.write(encodeFrame(OP_HANDSHAKE, handshakePayload))
    })

    // Discord sends a READY dispatch after the handshake; only once that
    // arrives will it accept further commands like SET_ACTIVITY.
    this.sock.on('data', (chunk: Buffer) => {
      const hadFrames = this.reader.push(chunk).length > 0
      if (hadFrames && !this.ready) {
        this.ready = true
        for (const frame of this.pending.splice(0)) this.sock.write(frame)
        if (this.closeAfterPending) this.sock.end()
      }
    })

    this.sock.on('error', onClose)
    this.sock.on('close', onClose)
  }

  sendActivity(payload: Buffer): void {
    const frame = encodeFrame(OP_FRAME, payload)
    if (this.ready) {
      if (this.sock.writable) this.sock.write(frame)
    } else {
      this.pending.push(frame)
    }
  }

  /** Sends a final frame (after the handshake) and closes the connection once it has been flushed. */
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
