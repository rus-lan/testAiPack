// diff2html imports @profoundlogic/hogan for its template renderer, but that
// package ships no type declarations. This ambient shim declares the members
// diff2html's own .d.ts references, so `tsc` (skipLibCheck: false) can check it.
declare module '@profoundlogic/hogan' {
  export type Template = unknown
  export type Context = unknown
  export type Partials = unknown
}
