import { Fixture, RGBW } from '../types';

export class GPUMapper {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram | null = null;
  private mapTexture: WebGLTexture | null = null;
  private sourceTexture: WebGLTexture | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  
  private totalLeds: number = 0;
  private width: number = 512;
  private height: number = 512;
  private brightness: number = 1.0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1; // Will resize based on LED count
    this.canvas.height = 1;
    
    // Try standard WebGL first, then experimental
    let gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) {
        gl = this.canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true }) as WebGLRenderingContext | null;
    }

    if (!gl) {
        throw new Error("WebGL not supported");
    }
    this.gl = gl;
    
    // Enable Float Textures for coordinate mapping
    const ext = gl.getExtension('OES_texture_float');
    if (!ext) console.warn("OES_texture_float not supported, mapping precision might be low");

    this.initShaders();
    this.initBuffers();
  }

  private initShaders() {
    const gl = this.gl;

    // Vertex Shader
    const vsSource = `
      attribute vec2 position;
      varying vec2 vTexCoord;
      void main() {
        // Map -1..1 to 0..1
        vTexCoord = position * 0.5 + 0.5; 
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    // Fragment Shader
    const fsSource = `
      precision mediump float;
      uniform sampler2D u_source;
      uniform sampler2D u_map;
      uniform float u_brightness;
      varying vec2 vTexCoord;

      void main() {
        // Map texture contains (u, v, 0, 1)
        vec2 samplePos = texture2D(u_map, vTexCoord).xy;
        vec4 color = texture2D(u_source, samplePos);
        
        // RGBW Encoding (Min-Subtraction)
        float minVal = min(min(color.r, color.g), color.b);
        float factor = 1.0;
        
        gl_FragColor = vec4(
          (color.r - (minVal * factor)) * u_brightness,
          (color.g - (minVal * factor)) * u_brightness,
          (color.b - (minVal * factor)) * u_brightness,
          minVal * factor * u_brightness
        );
      }
    `;

    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    
    this.program = gl.createProgram();
    if (!this.program || !vs || !fs) return;

    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    
    // Clean up individual shaders after link
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error('Shader program init failed:', gl.getProgramInfoLog(this.program));
    }
  }

  private compileShader(type: number, source: string) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile failed:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  private initBuffers() {
    const gl = this.gl;
    const positions = new Float32Array([
      -1.0, -1.0,
       1.0, -1.0,
      -1.0,  1.0,
       1.0,  1.0,
    ]);
    this.vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  }

  public setBrightness(value: number) {
      this.brightness = Math.max(0, Math.min(1, value));
  }

  public updateMapping(fixtures: Fixture[]) {
    const gl = this.gl;
    
    this.totalLeds = fixtures.reduce((acc, f) => acc + f.ledCount, 0);
    if (this.totalLeds === 0) return;

    if (this.canvas.width !== this.totalLeds || this.canvas.height !== 1) {
      this.canvas.width = this.totalLeds;
      this.canvas.height = 1;
      gl.viewport(0, 0, this.totalLeds, 1);
    }

    const data = new Float32Array(this.totalLeds * 4);
    let offset = 0;

    fixtures.forEach(f => {
      const cx = f.x + f.width / 2;
      const cy = f.y + f.height / 2;
      const rads = (f.rotation || 0) * (Math.PI / 180);
      const cos = Math.cos(rads);
      const sin = Math.sin(rads);
      const fw = f.width;
      const fh = f.height;
      const isHorizontal = fw * this.width >= fh * this.height;

      for (let i = 0; i < f.ledCount; i++) {
        let lx = 0;
        let ly = 0;

        if (isHorizontal) {
           const step = fw / f.ledCount;
           lx = ((i * step) + (step / 2)) - (fw / 2);
        } else {
           const step = fh / f.ledCount;
           ly = ((i * step) + (step / 2)) - (fh / 2);
        }

        const lx_px = lx * this.width;
        const ly_px = ly * this.height;
        const rx_px = lx_px * cos - ly_px * sin;
        const ry_px = lx_px * sin + ly_px * cos;
        const u = cx + (rx_px / this.width);
        const v = cy + (ry_px / this.height);

        data[offset] = u;
        data[offset + 1] = v; 
        data[offset + 2] = 0;
        data[offset + 3] = 1;
        offset += 4;
      }
    });

    if (!this.mapTexture) this.mapTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.mapTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.totalLeds, 1, 0, gl.RGBA, gl.FLOAT, data);
  }

  public updateSource(source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement) {
    const gl = this.gl;
    if (!this.sourceTexture) this.sourceTexture = gl.createTexture();
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    
    try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (e) {
        return; 
    }

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  public read(): Uint8Array | null {
    if (!this.program || this.totalLeds === 0) return null;
    const gl = this.gl;

    gl.useProgram(this.program);

    const uSource = gl.getUniformLocation(this.program, "u_source");
    const uMap = gl.getUniformLocation(this.program, "u_map");
    const uBrightness = gl.getUniformLocation(this.program, "u_brightness");
    
    gl.uniform1i(uSource, 0); 
    gl.uniform1i(uMap, 1);    
    gl.uniform1f(uBrightness, this.brightness);

    const positionLocation = gl.getAttribLocation(this.program, "position");
    gl.enableVertexAttribArray(positionLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const pixels = new Uint8Array(this.totalLeds * 4);
    gl.readPixels(0, 0, this.totalLeds, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    
    return pixels;
  }

  public dispose() {
      const gl = this.gl;
      // Lose Context extension if available (force cleanup)
      const loseContext = gl.getExtension('WEBGL_lose_context');
      
      if (this.program) gl.deleteProgram(this.program);
      if (this.mapTexture) gl.deleteTexture(this.mapTexture);
      if (this.sourceTexture) gl.deleteTexture(this.sourceTexture);
      if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
      
      this.program = null;
      this.mapTexture = null;
      this.sourceTexture = null;
      this.vertexBuffer = null;

      if (loseContext) loseContext.loseContext();
  }
}