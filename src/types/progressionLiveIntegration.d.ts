// The application does not otherwise depend on Node type declarations. These
// narrow declarations cover the local-only integration harness APIs it uses.
declare module 'node:child_process' {
  export function execFile(...args: any[]): any
  export function spawn(...args: any[]): any
}

declare module 'node:util' {
  export function promisify(fn: (...args: any[]) => any): (...args: any[]) => Promise<any>
}

