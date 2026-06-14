import * as net from 'net'
import { encodeFrame, FrameReader, OP_FRAME, OP_HANDSHAKE } from './ipc-protocol'

/**
 * A lazily-established connection to a secondary Discord instance that
 * mirrors the primary connection's handshake and SET_ACTIVITY frames.
 */
export class MirrorConnection {
  private readonly sock: net.Socket
  private readonly reader = new FrameReader()

  constructor(socketPath: string, handshakePayload: Buffer, onClose: () => void) {
    this.sock = net.createConnection(socketPath)

    this.sock.on('connect', () => {
      this.sock.write(encodeFrame(OP_HANDSHAKE, handshakePayload))
    })

    // Drain responses; the mirror connection only needs to look like a real client.
    this.sock.on('data', (chunk) => this.reader.push(chunk))

    this.sock.on('error', onClose)
    this.sock.on('close', onClose)
  }

  sendActivity(payload: Buffer): void {
    if (this.sock.writable) {
      this.sock.write(encodeFrame(OP_FRAME, payload))
    }
  }

  destroy(): void {
    this.sock.destroy()
  }
}
