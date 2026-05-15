import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

export interface ConvertedComposeService {
  name: string;
  image: string;
  replicas: number;
  ports: { name?: string; containerPort: number; servicePort: number; protocol: string }[];
  env: { key: string; value: string }[];
  volumes: { name: string; type: 'pvc' | 'emptyDir'; mountPath: string; storageSize?: string }[];
  command?: string[];
}

interface KomposeResult {
  files: { name: string; content: string }[];
}

async function runKompose(composeYaml: string): Promise<KomposeResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchard-compose-'));
  const inputPath = path.join(tmpDir, 'docker-compose.yml');
  const outDir = path.join(tmpDir, 'out');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(inputPath, composeYaml, 'utf-8');

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('kompose', ['convert', '-f', inputPath, '-o', outDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      proc.stderr.on('data', (d) => (stderr += d.toString()));
      proc.on('error', (err) => reject(new Error(`kompose failed to start: ${err.message}`)));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`kompose exited with code ${code}: ${stderr.slice(0, 2000)}`));
      });
    });

    const entries = await fs.readdir(outDir);
    const files: { name: string; content: string }[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
      const content = await fs.readFile(path.join(outDir, entry), 'utf-8');
      files.push({ name: entry, content });
    }
    return { files };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseDocs(content: string): any[] {
  const docs: any[] = [];
  for (const doc of yaml.loadAll(content)) {
    if (doc && typeof doc === 'object') docs.push(doc);
  }
  return docs;
}

function getComposeServiceLabel(obj: any): string | undefined {
  return obj?.metadata?.labels?.['io.kompose.service'];
}

export function validateCompose(composeYaml: string): { services: string[] } {
  let parsed: any;
  try {
    parsed = yaml.load(composeYaml);
  } catch (e: any) {
    throw new Error(`Invalid YAML: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Compose file must be a YAML object');
  }
  const services = parsed.services;
  if (!services || typeof services !== 'object') {
    throw new Error('Compose file must define a `services` key');
  }
  const names = Object.keys(services);
  if (names.length === 0) {
    throw new Error('Compose file must define at least one service');
  }
  for (const [name, svc] of Object.entries<any>(services)) {
    if (svc?.build) {
      throw new Error(
        `Service "${name}" uses \`build:\` — building from source is not supported in Compose stacks. Deploy from GitHub instead.`,
      );
    }
    if (!svc?.image) {
      throw new Error(`Service "${name}" must have an \`image:\` field`);
    }
  }
  return { services: names };
}

export async function convertCompose(composeYaml: string): Promise<ConvertedComposeService[]> {
  validateCompose(composeYaml);
  const { files } = await runKompose(composeYaml);

  const deployments = new Map<string, any>();
  const services = new Map<string, any[]>();
  const pvcs = new Map<string, any>();

  for (const file of files) {
    for (const doc of parseDocs(file.content)) {
      const label = getComposeServiceLabel(doc);
      if (!label) continue;
      switch (doc.kind) {
        case 'Deployment':
        case 'StatefulSet':
          deployments.set(label, doc);
          break;
        case 'Service': {
          const arr = services.get(label) ?? [];
          arr.push(doc);
          services.set(label, arr);
          break;
        }
        case 'PersistentVolumeClaim':
          if (doc?.metadata?.name) pvcs.set(doc.metadata.name, doc);
          break;
      }
    }
  }

  const out: ConvertedComposeService[] = [];

  for (const [name, dep] of deployments) {
    const container = dep?.spec?.template?.spec?.containers?.[0];
    if (!container) continue;
    const image = container.image;
    if (!image) continue;

    const replicas = typeof dep.spec.replicas === 'number' && dep.spec.replicas > 0 ? dep.spec.replicas : 1;

    const env: { key: string; value: string }[] = Array.isArray(container.env)
      ? container.env
          .filter((e: any) => e && typeof e.name === 'string')
          .map((e: any) => ({ key: e.name, value: e.value != null ? String(e.value) : '' }))
      : [];

    const ports: ConvertedComposeService['ports'] = [];
    const svcDocs = services.get(name) ?? [];
    for (const svc of svcDocs) {
      for (const p of svc.spec?.ports ?? []) {
        const containerPort = typeof p.targetPort === 'number'
          ? p.targetPort
          : Number.parseInt(String(p.targetPort), 10) || p.port;
        ports.push({
          name: typeof p.name === 'string' ? p.name : undefined,
          containerPort,
          servicePort: p.port,
          protocol: (p.protocol || 'TCP').toUpperCase(),
        });
      }
    }
    if (ports.length === 0 && Array.isArray(container.ports)) {
      for (const p of container.ports) {
        if (typeof p.containerPort === 'number') {
          ports.push({
            containerPort: p.containerPort,
            servicePort: p.containerPort,
            protocol: (p.protocol || 'TCP').toUpperCase(),
          });
        }
      }
    }

    const volumes: ConvertedComposeService['volumes'] = [];
    const mounts: any[] = Array.isArray(container.volumeMounts) ? container.volumeMounts : [];
    const podVolumes: any[] = Array.isArray(dep.spec?.template?.spec?.volumes)
      ? dep.spec.template.spec.volumes
      : [];
    for (const mount of mounts) {
      const pv = podVolumes.find((v) => v.name === mount.name);
      if (!pv) continue;
      if (pv.persistentVolumeClaim?.claimName) {
        const pvc = pvcs.get(pv.persistentVolumeClaim.claimName);
        const storageSize: string | undefined =
          pvc?.spec?.resources?.requests?.storage ?? '1Gi';
        volumes.push({
          name: mount.name,
          type: 'pvc',
          mountPath: mount.mountPath,
          storageSize,
        });
      } else if (pv.emptyDir !== undefined) {
        volumes.push({
          name: mount.name,
          type: 'emptyDir',
          mountPath: mount.mountPath,
        });
      }
    }

    out.push({
      name,
      image,
      replicas,
      ports,
      env,
      volumes,
      command: Array.isArray(container.command) ? container.command : undefined,
    });
  }

  return out;
}
