import { matchScreenPath, type HostRoute } from '@orchardlabs/graft-sdk/client';

const PARAM_ROUTES = ['/sandboxes/:id'];

function paramsFor(path: string): Record<string, string> {
  for (const pattern of PARAM_ROUTES) {
    const params = matchScreenPath(pattern, path);
    if (params) return params;
  }
  return {};
}

class PageState {
  url = $state(new URL(typeof location === 'undefined' ? 'http://localhost/' : location.href));
  params = $state<Record<string, string>>({});

  sync(route: HostRoute) {
    const next = new URL(`${route.path}${route.search}`, location.origin);
    if (next.href !== this.url.href) this.url = next;
    const params = paramsFor(route.path);
    if (JSON.stringify(params) !== JSON.stringify(this.params)) this.params = params;
  }
}

export const page = new PageState();
