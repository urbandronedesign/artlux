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
  wsBridgeUrl: string;
  useWsBridge: boolean;
}

export enum ViewMode {
  MAPPING = 'MAPPING',
  MONITORING = 'MONITORING'
}