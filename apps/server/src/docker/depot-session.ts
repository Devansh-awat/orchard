import { mergeRegistryAuths, type RegistryAuths } from './registry-pull-auth';

export function depotSessionAuths(opts: {
  sidecarPush: boolean;
  harborAuths: RegistryAuths;
  appPullAuths: RegistryAuths;
}): RegistryAuths {
  return opts.sidecarPush
    ? { ...opts.appPullAuths }
    : mergeRegistryAuths(opts.harborAuths, opts.appPullAuths);
}

export function depotOutputFlags(opts: { sidecarPush: boolean; imageName: string }): string {
  if (opts.sidecarPush) return '--output "type=oci,dest=/output/image.tar"';
  return `-t "${opts.imageName}" --push`;
}

export function depotScriptTail(sidecarPush: boolean): { pre: string; post: string } {
  if (!sidecarPush) return { pre: '', post: '' };
  return {
    pre: 'mkdir -p /output\n',
    post: `if [ "$BUILD_RC" -eq 0 ]; then touch /output/.done; else touch /output/.failed; fi\n`
  };
}
