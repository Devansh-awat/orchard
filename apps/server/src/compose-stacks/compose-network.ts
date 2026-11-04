export interface ComposePort {
  containerPort: number;
  servicePort: number;
  protocol: string;
}

export interface ComposeAlias {
  name: string;
  target: string;
  ports: { port: number; protocol: string }[];
}

const ALIAS_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const NOT_HTTP = new Set([
  1433, 1521, 2181, 3306, 5432, 5672, 6379, 9042, 9092, 11211, 15672, 25, 27017, 33060, 53
]);

function protocolOf(value: unknown): string {
  return String(value ?? '').toLowerCase() === 'udp' ? 'UDP' : 'TCP';
}

function shortPort(raw: string): ComposePort | null {
  const [address, protocol] = raw.trim().split('/');
  const parts = address.split(':');
  const containerPort = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(containerPort)) return null;
  const hostPort = parts.length > 1 ? parseInt(parts[parts.length - 2], 10) : NaN;
  return {
    containerPort,
    servicePort: Number.isFinite(hostPort) ? hostPort : containerPort,
    protocol: protocolOf(protocol)
  };
}

function longPort(entry: any): ComposePort | null {
  const containerPort = parseInt(String(entry?.target ?? entry?.published), 10);
  if (!Number.isFinite(containerPort)) return null;
  const hostPort = parseInt(String(entry?.published), 10);
  return {
    containerPort,
    servicePort: Number.isFinite(hostPort) ? hostPort : containerPort,
    protocol: protocolOf(entry?.protocol)
  };
}

export function parseComposePorts(svc: any): { ports: ComposePort[]; published: ComposePort[] } {
  const published: ComposePort[] = [];
  const seen = new Set<string>();
  const add = (list: ComposePort[], port: ComposePort | null) => {
    if (!port) return;
    const key = `${port.containerPort}/${port.protocol}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(port);
  };
  for (const entry of Array.isArray(svc?.ports) ? svc.ports : []) {
    add(
      published,
      entry !== null && typeof entry === 'object' ? longPort(entry) : shortPort(String(entry))
    );
  }
  const exposed: ComposePort[] = [];
  for (const entry of Array.isArray(svc?.expose) ? svc.expose : []) {
    add(exposed, shortPort(String(entry)));
  }
  return { ports: [...published, ...exposed], published };
}

export function urlPortOf(published: ComposePort[]): number | null {
  const web = published.find((p) => p.protocol === 'TCP' && !NOT_HTTP.has(p.containerPort));
  return web ? web.servicePort : null;
}

export function composeAliasName(service: string): string | null {
  const name = service.toLowerCase();
  return ALIAS_NAME.test(name) ? name : null;
}

export function planComposeAliases(
  children: {
    name: string;
    composeServiceName: string | null;
    services: { ports: { targetPort: number; protocol: string }[] }[];
  }[]
): ComposeAlias[] {
  const aliases: ComposeAlias[] = [];
  for (const child of children) {
    const name = child.composeServiceName ? composeAliasName(child.composeServiceName) : null;
    if (!name || name === child.name) continue;
    const ports = new Map<string, { port: number; protocol: string }>();
    for (const service of child.services) {
      for (const port of service.ports) {
        const protocol = protocolOf(port.protocol);
        ports.set(`${port.targetPort}/${protocol}`, { port: port.targetPort, protocol });
      }
    }
    if (ports.size > 0) aliases.push({ name, target: child.name, ports: [...ports.values()] });
  }
  return aliases;
}

export function aliasConflictMessage(names: string[]): string {
  const list = names.join(', ');
  return `The name ${list} is already used in this project. Services in a compose file reach each other by name, so use another project or environment, or rename the service.`;
}
