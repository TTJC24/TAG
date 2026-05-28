declare module 'heic-decode' {
  export interface HeicDecodeResult {
    data: ArrayBuffer | Uint8Array | Uint8ClampedArray;
    width: number;
    height: number;
  }

  export interface HeicDecodeOptions {
    buffer: Buffer | ArrayBuffer | Uint8Array;
  }

  const decode: (opts: HeicDecodeOptions) => Promise<HeicDecodeResult>;
  export default decode;
}

declare module 'js-yaml' {
  export function dump(value: unknown, opts?: Record<string, unknown>): string;
  export function load(value: string, opts?: Record<string, unknown>): unknown;
  export function safeLoad(value: string, opts?: Record<string, unknown>): unknown;
}

declare module '@jsquash/avif/codec/dec/avif_dec.wasm' {
  const path: string;
  export default path;
}

declare module '@jsquash/png/encode.js' {
  export interface PngImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }

  const encode: (imageData: PngImageData) => Promise<ArrayBuffer>;
  export default encode;
}
