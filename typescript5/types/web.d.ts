/**
 * The Web APIs the platform-neutral core uses, which browsers, Node and Deno all provide. Declared here (only for
 * tsconfig.core.json) instead of loading the DOM library, so that the core cannot use browser-only APIs either.
 */

interface TextDecoderOptions {
  fatal?: boolean;
  ignoreBOM?: boolean;
}

declare class TextDecoder {
  constructor(label?: string, options?: TextDecoderOptions);
  decode(input?: Uint8Array): string;
}
