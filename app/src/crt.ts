// The display pass and pointer mapping use the same edge-preserving barrel projection.
// Use a GPU pass when available, with SVG displacement as the compatibility fallback.
const CURVE = 0.055;
const MAP_SIZE = 512;
const SVG = "http://www.w3.org/2000/svg";

export class ScreenCurve {
  private active = false;
  private width = 1;
  private height = 1;
  private image: SVGFEImageElement | null = null;
  private displacement: SVGFEDisplacementMapElement | null = null;
  private pass: ScreenPass | null = null;

  constructor(available = true) {
    // Archive renderers never use CRT: avoid creating GPU contexts and global SVG filters for them.
    if (!available) return;
    this.pass = ScreenPass.create(() => {
      this.pass?.canvas.remove();
      this.pass = null;
      this.enabled = this.active;
    });
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    svg.style.pointerEvents = "none";
    const filter = document.createElementNS(SVG, "filter");
    filter.id = "machine-crt-bend";
    for (const [name, value] of Object.entries({ x: "0", y: "0", width: "100%", height: "100%",
      filterUnits: "objectBoundingBox", primitiveUnits: "userSpaceOnUse", "color-interpolation-filters": "sRGB" })) filter.setAttribute(name, value);
    this.image = document.createElementNS(SVG, "feImage");
    this.image.setAttribute("preserveAspectRatio", "none");
    this.image.setAttribute("result", "curve");
    this.displacement = document.createElementNS(SVG, "feDisplacementMap");
    this.displacement.setAttribute("in", "SourceGraphic");
    this.displacement.setAttribute("in2", "curve");
    this.displacement.setAttribute("xChannelSelector", "R");
    this.displacement.setAttribute("yChannelSelector", "G");
    filter.append(this.image, this.displacement);
    svg.append(filter);
    document.body.append(svg);
  }

  get enabled() { return this.active; }
  set enabled(on: boolean) {
    this.active = on && this.image !== null;
    if (this.image) document.body.classList.toggle("crt-webgl", this.active && this.pass !== null);
  }

  render(source: HTMLCanvasElement) {
    if (this.active && this.pass) this.pass.render(source);
  }

  resize(width: number, height: number) {
    if (!width || !height || (width === this.width && height === this.height)) return;
    this.width = width;
    this.height = height;
    if (!this.image || !this.displacement) return;
    const scale = .45 * CURVE * Math.max(width, height);
    const map = document.createElement("canvas");
    map.width = map.height = MAP_SIZE;
    const ctx = map.getContext("2d")!;
    const pixels = ctx.createImageData(MAP_SIZE, MAP_SIZE);
    for (let y = 0; y < MAP_SIZE; y++) for (let x = 0; x < MAP_SIZE; x++) {
      const nx = 2 * (x + .5) / MAP_SIZE - 1, ny = 2 * (y + .5) / MAP_SIZE - 1;
      const i = 4 * (y * MAP_SIZE + x);
      // Fade displacement to zero at each edge: bow the glass without cropping its corners.
      pixels.data[i] = 255 * (.5 + CURVE * nx * ny * ny * (1 - nx * nx) * width / (2 * scale));
      pixels.data[i + 1] = 255 * (.5 + CURVE * ny * nx * nx * (1 - ny * ny) * height / (2 * scale));
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    this.image.setAttribute("width", String(width));
    this.image.setAttribute("height", String(height));
    this.image.setAttribute("href", map.toDataURL());
    this.displacement.setAttribute("scale", String(scale));
  }

  /** Where a curved screen pixel samples the original, flat canvas. */
  screenToFlat(sx: number, sy: number): [number, number] {
    if (!this.enabled) return [sx, sy];
    const x = 2 * sx / this.width - 1, y = 2 * sy / this.height - 1;
    return [(x * (1 + CURVE * y * y * (1 - x * x)) + 1) * this.width / 2,
      (y * (1 + CURVE * x * x * (1 - y * y)) + 1) * this.height / 2];
  }

  /** Invert the barrel warp for toolbars and world positions shown on screen. */
  flatToScreen(sx: number, sy: number): [number, number] {
    if (!this.enabled) return [sx, sy];
    const qx = 2 * sx / this.width - 1, qy = 2 * sy / this.height - 1;
    if (Math.abs(qx) > 1 || Math.abs(qy) > 1) return [sx, sy];
    let x = qx, y = qy;
    for (let i = 0; i < 6; i++) {
      const a = 1 + CURVE * y * y * (1 - 3 * x * x), d = 1 + CURVE * x * x * (1 - 3 * y * y);
      const b = 2 * CURVE * x * y * (1 - x * x), c = 2 * CURVE * x * y * (1 - y * y);
      const fx = x * (1 + CURVE * y * y * (1 - x * x)) - qx;
      const fy = y * (1 + CURVE * x * x * (1 - y * y)) - qy, det = a * d - b * c;
      x -= (d * fx - b * fy) / det;
      y -= (a * fy - c * fx) / det;
    }
    return [(x + 1) * this.width / 2, (y + 1) * this.height / 2];
  }
}

/** A single textured triangle. The machine still draws to its antialiased 2D canvas. */
class ScreenPass {
  private texture: WebGLTexture;
  private textureWidth = 0;
  private textureHeight = 0;

  private constructor(public canvas: HTMLCanvasElement, private gl: WebGLRenderingContext) {
    const shader = (type: number, code: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, code);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); throw new Error("CRT shader unavailable"); }
      return s;
    };
    const vertex = shader(gl.VERTEX_SHADER, `attribute vec2 position; varying vec2 uv;
      void main() { uv = position * .5 + .5; gl_Position = vec4(position, 0., 1.); }`);
    const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision ? "highp" : "mediump";
    const fragment = shader(gl.FRAGMENT_SHADER, `precision ${precision} float; varying vec2 uv; uniform sampler2D screen;
      void main() {
        vec2 p = uv * 2. - 1.;
        vec2 bent = p * (1. + ${CURVE} * p.yx * p.yx * (1. - p * p));
        gl_FragColor = texture2D(screen, (bent + 1.) * .5);
      }`);
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); throw new Error("CRT program unavailable"); }
    gl.useProgram(program);
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    this.texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.uniform1i(gl.getUniformLocation(program, "screen"), 0);
  }

  static create(lost: () => void): ScreenPass | null {
    const canvas = document.createElement("canvas");
    canvas.id = "crt-screen";
    canvas.setAttribute("aria-hidden", "true");
    try {
      const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, failIfMajorPerformanceCaveat: true });
      if (!gl) return null;
      // A software WebGL implementation costs more than the compositor fallback.
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      if (debug && /SwiftShader|llvmpipe|softpipe|Software Rasterizer/i.test(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))) {
        gl.getExtension("WEBGL_lose_context")?.loseContext();
        return null;
      }
      const pass = new ScreenPass(canvas, gl);
      canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); lost(); });
      document.getElementById("crt-glass")!.insertBefore(canvas, document.getElementById("crt"));
      return pass;
    } catch { return null; }
  }

  render(source: HTMLCanvasElement) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (this.canvas.width !== source.width || this.canvas.height !== source.height) {
      this.canvas.width = source.width; this.canvas.height = source.height;
      gl.viewport(0, 0, source.width, source.height);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (source.width !== this.textureWidth || source.height !== this.textureHeight) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.textureWidth = source.width; this.textureHeight = source.height;
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
