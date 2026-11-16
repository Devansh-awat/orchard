import * as k8s from '@kubernetes/client-node';

export const MANAGED_VOLUMES_ANNOTATION = 'orchard.my/managed-volumes';
export const VOLUMES_UPDATED_ANNOTATION = 'orchard.my/volumes-updated-at';

export function recordedVolumeNames(deployment: k8s.V1Deployment): Set<string> {
  const raw = deployment.spec?.template?.metadata?.annotations?.[MANAGED_VOLUMES_ANNOTATION];
  if (raw === undefined) return new Set();
  const names: unknown = JSON.parse(raw);
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
    throw new Error('Invalid managed volume names');
  }
  return new Set(names);
}

export function buildVolumeReplacePatch(options: {
  deployment: k8s.V1Deployment;
  managedNames: Set<string>;
  volumes: k8s.V1Volume[];
  mounts: k8s.V1VolumeMount[];
  strategy: k8s.V1DeploymentStrategy;
  stamp: string;
}) {
  const { deployment, managedNames, volumes, mounts, stamp } = options;
  const template = deployment.spec!.template;
  const spec = template.spec!;
  const primary = spec.containers[0];
  const desiredNames = new Set(volumes.map((volume) => volume.name));
  const externalReferences = new Set(
    [
      ...spec.containers.slice(1),
      ...(spec.initContainers ?? []),
      ...(spec.ephemeralContainers ?? [])
    ].flatMap((container) => [
      ...(container.volumeMounts ?? []).map((mount) => mount.name),
      ...(container.volumeDevices ?? []).map((device) => device.name)
    ])
  );
  for (const device of primary.volumeDevices ?? []) externalReferences.add(device.name);
  const liveVolumes = spec.volumes ?? [];
  for (const volume of volumes) {
    const existing = liveVolumes.find((live) => live.name === volume.name);
    if (existing && !managedNames.has(volume.name)) {
      throw new Error(`Volume "${volume.name}" is not managed by Orchard for this container`);
    }
    if (
      existing &&
      externalReferences.has(volume.name) &&
      JSON.stringify(existing) !== JSON.stringify(volume)
    ) {
      throw new Error(`Volume "${volume.name}" is also used by another container`);
    }
  }
  const preservedMounts = (primary.volumeMounts ?? []).filter(
    (mount) => !managedNames.has(mount.name)
  );
  for (const mount of mounts) {
    if (preservedMounts.some((existing) => existing.mountPath === mount.mountPath)) {
      throw new Error(`Mount path "${mount.mountPath}" is used by an unmanaged volume`);
    }
  }
  const nextVolumes = [
    ...liveVolumes.filter(
      (volume) =>
        !desiredNames.has(volume.name) &&
        (!managedNames.has(volume.name) || externalReferences.has(volume.name))
    ),
    ...volumes
  ];
  const annotations = {
    ...template.metadata?.annotations,
    [MANAGED_VOLUMES_ANNOTATION]: JSON.stringify([...desiredNames].sort()),
    [VOLUMES_UPDATED_ANNOTATION]: stamp
  };
  const operations: { op: 'test' | 'add'; path: string; value: unknown }[] = [];
  if (deployment.metadata?.resourceVersion) {
    operations.push({
      op: 'test',
      path: '/metadata/resourceVersion',
      value: deployment.metadata.resourceVersion
    });
  }
  const strategy = nextVolumes.some((volume) => volume.persistentVolumeClaim)
    ? { type: 'Recreate', rollingUpdate: null }
    : options.strategy;
  operations.push(
    template.metadata
      ? { op: 'add', path: '/spec/template/metadata/annotations', value: annotations }
      : { op: 'add', path: '/spec/template/metadata', value: { annotations } },
    { op: 'add', path: '/spec/strategy', value: strategy },
    {
      op: 'add',
      path: '/spec/template/spec/containers/0/volumeMounts',
      value: [...preservedMounts, ...mounts]
    },
    { op: 'add', path: '/spec/template/spec/volumes', value: nextVolumes }
  );
  return { operations, strategy };
}
