export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface RGBW extends RGB {
  w: number;
}

export enum PixelSource {
  MEDIA = 'MEDIA',   // sample the video/image source at the fixture's position
  EFFECT = 'EFFECT'  // generate color from a built-in effect + palette
}

export interface Fixture {
  id: string;
  name: string;
  x: number; // Normalized 0-1 relative to stage width
  y: number; // Normalized 0-1 relative to stage height
  width: number; // Normalized 0-1
  height: number; // Normalized 0-1
  rotation: number; // Degrees
  universe: number;
  startAddress: number;
  ledCount: number;
  reverse: boolean;
  colorData: RGBW[]; // Live data
  // Phase C — effects/palettes (optional for back-compat; default to MEDIA).
  source?: PixelSource;
  effectId?: number;   // index into EFFECT_NAMES
  paletteId?: number;  // index into PALETTE_NAMES
  speed?: number;      // 0..1
  intensity?: number;  // 0..1
}

export enum SourceType {
  VIDEO = 'VIDEO',
  IMAGE = 'IMAGE',
  CAMERA = 'CAMERA',
  NONE = 'NONE'
}

export interface AppSettings {
  artNetIp: string;
  artNetPort: number;
  outputEnabled: boolean; // master enable for native Art-Net output
  broadcast: boolean;     // broadcast vs unicast to artNetIp
}

export enum ViewMode {
  MAPPING = 'MAPPING',
  MONITORING = 'MONITORING'
}