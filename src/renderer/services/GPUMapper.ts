import { Fixture, RGBW } from '../types';

export class GPUMapper {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram | null = null;
  private mapTexture: WebGLTexture | null = null;
  private sourceTexture: WebGLTexture | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  
  private totalLeds: number = 0;
  private width: number = 0; // Current allocated width
  private height: number = 1; // Current allocated height
  private brightness: number = 1.0;
  
  // Reusable buffer to prevent GC
  private pixelBuffer: Uint8Array | null = null;

  constructor(initialWidth: number, initialHeight: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1; 
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
    
    const ext = gl.getExtension('OES_texture_float');
    if (!ext) console.warn("OES_texture_float not supported, mapping precision might be low");

    this.initShaders();
    this.initBuffers();
    
    // Initialize empty textures
    this.mapTexture = gl.createTexture();
    this.sourceTexture = gl.createTexture();
  }

  private initShaders() {
    const gl = this.gl;

    const vsSource = `
      attribute vec2 position;
      varying vec2 vTexCoord;
      void main() {
        vTexCoord = position * 0.5 + 0.5; 
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    const fsSource = `
      precision mediump float;
      uniform sampler2D u_source;
      uniform sampler2D u_map;
      uniform float u_brightness;
      varying vec2 vTexCoord;

      void main() {
        vec2 samplePos = texture2D(u_map, vTexCoord).xy;
        vec4 color = texture2D(u_source, samplePos);
        
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
    gl.deleteShader(vs);
    gl.deleteShader(fs);
  }

  private compileShader(type: number, source: string) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  private initBuffers() {
    const gl = this.gl;
    const positions = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  }

  public setBrightness(value: number) {
      this.brightness = Math.max(0, Math.min(1, value));
  }

  public updateMapping(fixtures: Fixture[]) {
    const gl = this.gl;
    
    const newTotal = fixtures.reduce((acc, f) => acc + f.ledCount, 0);
    this.totalLeds = newTotal;
    
    if (this.totalLeds === 0) return;

    // Resize if necessary
    if (this.width !== this.totalLeds) {
        this.width = this.totalLeds;
        this.canvas.width = this.width;
        this.canvas.height = 1;
        gl.viewport(0, 0, this.width, 1);
        
        // Reallocate CPU buffer
        this.pixelBuffer = new Uint8Array(this.width * 4);
    }

    const data = new Float32Array(this.totalLeds * 4);
    let offset = 0;

    // Using 512 as assumed internal stage dimension for normalizing UVs if not passed
    // But normalized x/y are 0..1, so we just map directly.
    // However, the mapping logic used pixel-math in previous version.
    // Let's stick to 0..1 based on fixtures x/y.
    
    // We need map texture dimension to be totalLeds x 1
    
    fixtures.forEach(f => {
      const cx = f.x + f.width / 2;
      const cy = f.y + f.height / 2;
      const rads = (f.rotation || 0) * (Math.PI / 180);
      const cos = Math.cos(rads);
      const sin = Math.sin(rads);
      
      // Aspect ratio correction (Stage is square 1:1 usually, but let's assume square)
      
      for (let i = 0; i < f.ledCount; i++) {
        // Calculate relative position within fixture (0..1)
        let relX = 0, relY = 0;
        
        // Linear distribution along width or height?
        // Assuming horizontal strip if width > height
        const isHoriz = f.width >= f.height;
        
        if (isHoriz) {
            const step = f.width / f.ledCount;
            // Center is 0,0 relative
            relX = ((i * step) + (step/2)) - (f.width/2);
        } else {
            const step = f.height / f.ledCount;
            relY = ((i * step) + (step/2)) - (f.height/2);
        }
        
        // Rotate
        const rx = relX * cos - relY * sin;
        const ry = relX * sin + relY * cos;
        
        // World UV
        let u = cx + rx;
        let v = cy + ry; // Y is usually inverted in texture vs HTML coords?
        // In WebGL texture 0,0 is bottom-left. In HTML/CSS top-left.
        // Stage uses top-left 0,0. 
        // updateSource uses UNPACK_FLIP_Y_WEBGL = true, which flips the source image to match WebGL 0=bottom.
        // So we need to flip V.
        v = 1.0 - v;

        data[offset++] = u;
        data[offset++] = v;
        data[offset++] = 0;
        data[offset++] = 0;
      }
    });

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.mapTexture);
    
    // Check if we need to resize texture storage
    // texImage2D handles resizing if dims change.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, 1, 0, gl.RGBA, gl.FLOAT, data);
    
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  public updateSource(source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement) {
    const gl = this.gl;
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
    if (!this.program || this.totalLeds === 0 || !this.pixelBuffer) return null;
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

    gl.readPixels(0, 0, this.width, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixelBuffer);
    
    return this.pixelBuffer;
  }

  public dispose() {
      const gl = this.gl;
      const loseContext = gl.getExtension('WEBGL_lose_context');
      
      if (this.program) gl.deleteProgram(this.program);
      if (this.mapTexture) gl.deleteTexture(this.mapTexture);
      if (this.sourceTexture) gl.deleteTexture(this.sourceTexture);
      if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
      
      this.program = null;
      this.mapTexture = null;
      this.sourceTexture = null;
      this.vertexBuffer = null;
      this.pixelBuffer = null;
      this.width = 0;

      if (loseContext) loseContext.loseContext();
  }
}