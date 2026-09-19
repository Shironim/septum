import { runMCPServer } from "../../mcp/server.ts";

export async function handleServeCommand(): Promise<void> {
  await runMCPServer();
}
