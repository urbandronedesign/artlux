import { Fixture, RGBW } from '../types';

export class GPUMapper {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram | null = null;
  private mapTexture: WebGLTexture | null = null;
  private sourceTexture: WebGLTexture | null = null;
  private framebuffer: WebGLFramebuffer | null = null;
  
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
    if (!ext) console.warn("OES_texture_float not supported, mapping precision might be low if fallback used (fallback not impl)");

    this.initShaders();
    this.initBuffers();
  }

  private initShaders() {
    const gl = this.gl;

    // Vertex Shader: Renders a fullscreen quad (technically a 1xN line)
    const vsSource = `
      attribute vec2 position;
      varying vec2 vTexCoord;
      void main() {
        // Map -1..1 to 0..1
        vTexCoord = position * 0.5 + 0.5; 
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    // Fragment Shader: Samples source at mapped position and converts to RGBW
    const fsSource = `
      precision mediump float;
      uniform sampler2D u_source;
      uniform sampler2D u_map;
      uniform float u_brightness;
      varying vec2 vTexCoord;

      void main() {
        // 1. Get the sampling coordinate from the map texture
        // The map texture contains (u, v, 0, 1) in float format
        vec2 samplePos = texture2D(u_map, vTexCoord).xy;
        
        // 2. Sample the source video/image
        // Y-flip is handled during upload or coord gen. Let's assume coords are correct.
        vec4 color = texture2D(u_source, samplePos);
        
        // 3. Encode RGBW (GPU Compute)
        // Simple Min-Subtraction algorithm
        float minVal = min(min(color.r, color.g), color.b);
        float factor = 1.0;
        
        // Apply brightness scaling
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
    // Full coverage quad
    const positions = new Float32Array([
      -1.0, -1.0,
       1.0, -1.0,
      -1.0,  1.0,
       1.0,  1.0,
    ]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  }

  public setBrightness(value: number) {
      this.brightness = Math.max(0, Math.min(1, value));
  }

  /**
   * Updates the mapping texture based on fixture positions.
   * This generates the U,V coordinates for every LED.
   */
  public updateMapping(fixtures: Fixture[]) {
    const gl = this.gl;
    
    // 1. Calculate total LEDs
    this.totalLeds = fixtures.reduce((acc, f) => acc + f.ledCount, 0);
    if (this.totalLeds === 0) return;

    // 2. Resize Canvas/Viewport to N x 1
    // We map 1 pixel per LED in the X axis
    if (this.canvas.width !== this.totalLeds || this.canvas.height !== 1) {
      this.canvas.width = this.totalLeds;
      this.canvas.height = 1;
      gl.viewport(0, 0, this.totalLeds, 1);
    }

    // 3. Generate Coordinate Data (Float)
    // Format: R=u, G=v, B=0, A=1
    const data = new Float32Array(this.totalLeds * 4);
    let offset = 0;

    fixtures.forEach(f => {
      // Logic copied from Stage.tsx but generating normalized UVs
      const cx = f.x + f.width / 2;
      const cy = f.y + f.height / 2;
      
      const rads = (f.rotation || 0) * (Math.PI / 180);
      const cos = Math.cos(rads);
      const sin = Math.sin(rads);

      // Width/Height in UV space
      const fw = f.width;
      const fh = f.height;
      const isHorizontal = fw * this.width >= fh * this.height;

      for (let i = 0; i < f.ledCount; i++) {
        let lx = 0;
        let ly = 0;

        // Calculate local pos in 0..1 UV space relative to center
        if (isHorizontal) {
           const step = fw / f.ledCount;
           lx = ((i * step) + (step / 2)) - (fw / 2);
           ly = 0;
        } else {
           const step = fh / f.ledCount;
           lx = 0;
           ly = ((i * step) + (step / 2)) - (fh / 2);
        }

        // Rotate
        const lx_px = lx * this.width;
        const ly_px = ly * this.height;

        const rx_px = lx_px * cos - ly_px * sin;
        const ry_px = lx_px * sin + ly_px * cos;

        // Back to UV and add center
        const u = cx + (rx_px / this.width);
        const v = cy + (ry_px / this.height);

        // Store
        data[offset] = u;
        data[offset + 1] = v; 
        data[offset + 2] = 0;
        data[offset + 3] = 1;
        offset += 4;
      }
    });

    // 4. Upload to Texture
    if (!this.mapTexture) this.mapTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.mapTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Upload float data
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.totalLeds, 1, 0, gl.RGBA, gl.FLOAT, data);
  }

  public updateSource(source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement) {
    const gl = this.gl;
    if (!this.sourceTexture) this.sourceTexture = gl.createTexture();
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    
    // Flip Y so 0,0 is top-left matching our UV generation
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    
    // Upload
    // Note: If source is not ready, this might warn, caller should check
    try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (e) {
        return; // Source not ready
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

    // Bind Uniforms
    const uSource = gl.getUniformLocation(this.program, "u_source");
    const uMap = gl.getUniformLocation(this.program, "u_map");
    const uBrightness = gl.getUniformLocation(this.program, "u_brightness");
    
    gl.uniform1i(uSource, 0); // Unit 0
    gl.uniform1i(uMap, 1);    // Unit 1
    gl.uniform1f(uBrightness, this.brightness);

    // Draw
    const positionLocation = gl.getAttribLocation(this.program, "position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Read Pixels
    const pixels = new Uint8Array(this.totalLeds * 4);
    gl.readPixels(0, 0, this.totalLeds, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    
    return pixels;
  }
}