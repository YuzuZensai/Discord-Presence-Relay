/**
 * Discord IPC frames
 * https://discord.com/developers/docs/topics/rpc#payloads
 */
export const OP_HANDSHAKE = 0
export const OP_FRAME = 1

export interface Frame {
  op: number
  payload: Buffer
}

/** Buffers stream chunks and yields complete IPC frames as they arrive. */
export class FrameReader {
  private buf = Buffer.alloc(0)

  push(chunk: Buffer): Frame[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const frames: Frame[] = []

    for (;;) {
      if (this.buf.length < 8) break
      const op = this.buf.readUInt32LE(0)
      const len = this.buf.readUInt32LE(4)
      if (this.buf.length < 8 + len) break

      frames.push({ op, payload: Buffer.from(this.buf.subarray(8, 8 + len)) })
      this.buf = this.buf.subarray(8 + len)
    }

    return frames
  }
}

export function encodeFrame(op: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32LE(op, 0)
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}

/** Parses a non-handshake frame's JSON payload, returning null if it isn't JSON. */
export function parseFramePayload(frame: Frame): Record<string, unknown> | null {
  try {
    return JSON.parse(frame.payload.toString('utf8'))
  } catch {
    return null
  }
}
