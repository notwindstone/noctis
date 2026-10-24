// @sohumsuthar/liquid-glass ships its optics model as untyped .mjs.
declare module '@sohumsuthar/liquid-glass/optics' {
  export function buildDisplacementLUT(samples?: number, options?: object): { lut: Float32Array; peak: number }
  export function renderDisplacementMap(
    data: Uint8ClampedArray,
    options: { width: number; height: number; radius: number; bezel: number; lut: Float32Array; channelDepth?: number },
  ): Uint8ClampedArray
  export function dispersionScales(strength?: number): { red: number; green: number; blue: number }
}
