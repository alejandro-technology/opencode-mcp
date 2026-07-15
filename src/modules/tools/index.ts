import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// Tools
import { registerOpencodeGetTaskResult } from "./get_task_result.js";
import { registerOpencodeGetTaskStatus } from "./get_task_status.js";
import { registerOpencodeListAgents } from "./list_agents.js";
import { registerOpencodeStartServer } from "./start_server.js";
import { registerOpencodeStartTask } from "./start_task.js";
import { registerOpencodeStopServer } from "./stop_server.js";
import { registerOpencodeWaitForTask } from "./wait_for_task.js";

export function registerTools(server: McpServer) {
  registerOpencodeStartServer(server);
  registerOpencodeStopServer(server);
  registerOpencodeListAgents(server);
  registerOpencodeStartTask(server);
  registerOpencodeGetTaskStatus(server);
  registerOpencodeGetTaskResult(server);
  registerOpencodeWaitForTask(server);
}
