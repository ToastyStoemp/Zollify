/**
 * jsbarcode's encoders, reached directly: the package's own types cover only
 * the rendering entry point, which needs a canvas or an SVG element. The
 * encoders themselves need nothing - `encode()` gives the bars as text.
 */
declare module 'jsbarcode/bin/barcodes/index.js' {
  interface BarcodeEncoder {
    valid(): boolean;
    encode(): { data: string; text: string } | { data: string; text: string }[];
  }
  interface Code128Encoder extends BarcodeEncoder {
    encode(): { data: string; text: string };
  }
  const barcodes: {
    CODE128: new (text: string, options: Record<string, unknown>) => Code128Encoder;
    CODE128A: new (text: string, options: Record<string, unknown>) => Code128Encoder;
    CODE128B: new (text: string, options: Record<string, unknown>) => Code128Encoder;
    CODE128C: new (text: string, options: Record<string, unknown>) => Code128Encoder;
  };
  export default barcodes;
}
