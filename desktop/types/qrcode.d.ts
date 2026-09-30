declare module "qrcode" {
  export function toDataURL(text: string, options?: { width?: number, margin?: number, errorCorrectionLevel?: string }): Promise<string>;
  export function toString(text: string, options?: { type?: string, width?: number, margin?: number }): Promise<string>;
  export function toCanvas(canvas: any, text: string, options?: object): Promise<void>;
  const _default: {
    toDataURL: typeof toDataURL;
    toString: typeof toString;
    toCanvas: typeof toCanvas;
  };
  export default _default;
}
