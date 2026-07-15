export interface OpencodeServerInstance {
  serverId: string;
  baseUrl: string;
  close: () => void;
}

const servers = new Map<string, OpencodeServerInstance>();

export function registerServer(instance: OpencodeServerInstance) {
  servers.set(instance.serverId, instance);
}

export function getServer(serverId: string): OpencodeServerInstance | undefined {
  return servers.get(serverId);
}

export function removeServer(serverId: string) {
  servers.delete(serverId);
}

export function killAllServers() {
  for (const instance of servers.values()) {
    instance.close();
  }
  servers.clear();
}
