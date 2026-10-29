/**
 * Frame stream → WebGL canvas (frame-stream player).
 *
 * Rust renders mpv offscreen (`vo=libmpv`) and streams raw RGBA frames over a
 * loopback HTTP body (see `src-tauri/src/player/frames.rs`). This module parses
 * that stream and paints the newest frame into a `<canvas>` — the canvas is an
 * ordinary DOM node, so all player chrome / popups can overlay it freely.
 *
 * Wire format per frame (little-endian):
 *   `u32 width | u32 height | f64 pts | u32 pixelBytes | u32 reserved | RGBA…`
 * Pixels are bottom-up rows (GL order) — the vertex shader flips Y.
 */

const HEADER_BYTES = 24;

export type FrameHandler = (frame: {
  width: number;
  height: number;
  pts: number;
  pixels: Uint8Array;
}) => void;

/** Continuous reader for the loopback frame stream. */
export class FrameStream {
  private controller: AbortController | null = null;

  async connect(url: string, onFrame: FrameHandler): Promise<void> {
    this.close();
    const controller = new AbortController();
    this.controller = controller;
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`frame stream: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

    const append = (chunk: Uint8Array): Uint8Array<ArrayBufferLike> => {
      if (pending.length === 0) return chunk;
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending, 0);
      merged.set(chunk, pending.length);
      return merged;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        pending = append(value);

        let offset = 0;
        for (;;) {
          if (pending.length - offset < HEADER_BYTES) break;
          const view = new DataView(
            pending.buffer,
            pending.byteOffset + offset,
            HEADER_BYTES,
          );
          const width = view.getUint32(0, true);
          const height = view.getUint32(4, true);
          const pts = view.getFloat64(8, true);
          const pixelBytes = view.getUint32(16, true);
          const total = HEADER_BYTES + pixelBytes;
          if (width <= 0 || height <= 0 || pixelBytes !== width * height * 4) {
            // Corrupt header — resync by dropping the buffer.
            offset = pending.length;
            break;
          }
          if (pending.length - offset < total) break;
          onFrame({
            width,
            height,
            pts,
            pixels: pending.subarray(offset + HEADER_BYTES, offset + total),
          });
          offset += total;
        }
        pending =
          offset === 0 ? pending : pending.slice(offset);
      }
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") {
        console.warn("[player] frame stream:", error);
      }
    }
  }

  close(): void {
    this.controller?.abort();
    this.controller = null;
  }
}

/* ------------------------------------------------------------- WebGL sink */

const VERTEX_SHADER = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
}
`;

/** Draws incoming frames into a canvas via WebGL (latest-frame wins). */
export class CanvasVideoRenderer {
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private uTex: WebGLUniformLocation | null = null;
  private rafId = 0;
  private latest: { width: number; height: number; pixels: Uint8Array } | null =
    null;
  private frameDrawn = false;

  constructor(private canvas: HTMLCanvasElement) {
    const gl =
      canvas.getContext("webgl", {
        alpha: false,
        antialias: false,
        preserveDrawingBuffer: true,
      }) ?? null;
    if (!gl) {
      console.warn("[player] WebGL context unavailable — canvas stays black");
      return;
    }
    this.gl = gl;

    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn("[player] shader:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vs = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = vs && fs ? gl.createProgram() : null;
    if (!program || !vs || !fs) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn("[player] program:", gl.getProgramInfoLog(program));
      return;
    }
    this.program = program;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // Full-screen triangle strip (two triangles).
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this.uTex = gl.getUniformLocation(program, "u_tex");
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  /** Queue a frame for drawing (dropped when a newer one arrives first). */
  push(width: number, height: number, pixels: Uint8Array<ArrayBufferLike>): void {
    if (!this.gl) return;
    if (!this.frameDrawn) {
      const mid = (((height / 2) | 0) * width + ((width / 2) | 0)) * 4;
      console.info(
        `[player] first frame ${width}x${height} mid=RGBA ${pixels[mid]}/${pixels[mid + 1]}/${pixels[mid + 2]}/${pixels[mid + 3]}`,
      );
    }
    // Copy: the stream buffer is reused/sliced by the parser.
    this.latest = { width, height, pixels: pixels.slice() };
    this.scheduleDraw();
  }

  private scheduleDraw(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.draw();
    });
  }

  private draw(): void {
    const gl = this.gl;
    const frame = this.latest;
    if (!gl || !frame || !this.program || !this.texture) return;
    this.latest = null;

    if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
      this.canvas.width = frame.width;
      this.canvas.height = frame.height;
    }
    gl.viewport(0, 0, frame.width, frame.height);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      frame.width,
      frame.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      frame.pixels,
    );
    gl.useProgram(this.program);
    if (this.uTex) gl.uniform1i(this.uTex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.frameDrawn = true;
  }

  get hasFrame(): boolean {
    return this.frameDrawn;
  }

  destroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    const gl = this.gl;
    if (gl) {
      if (this.texture) gl.deleteTexture(this.texture);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.gl = null;
    this.program = null;
    this.texture = null;
  }
}
