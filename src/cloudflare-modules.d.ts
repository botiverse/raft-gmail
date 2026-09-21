declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}

declare module "cloudflare:node" {
  export function httpServerHandler(options: { port: number }): unknown;
}
