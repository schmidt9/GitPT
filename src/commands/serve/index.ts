import { Command } from "commander";
import { startServer } from "./server.js";

export interface ServeOptions {
  port?: string;
  host?: string;
  model?: string;
}

export const serveCommand = async (
  options: ServeOptions,
  _command: Command,
): Promise<void> => {
  const port = Number(options.port ?? process.env.GITPT_SERVE_PORT ?? 9999);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  const host = options.host ?? process.env.GITPT_SERVE_HOST ?? "127.0.0.1";
  const defaultModel = options.model ?? process.env.GITPT_SERVE_MODEL ?? "foundation";

  await startServer({ port, host, defaultModel });
};