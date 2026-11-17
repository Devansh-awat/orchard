const API_URL = process.env.ORCHARD_API_URL || 'http://localhost:3001';
const API_TOKEN = process.env.ORCHARD_API_TOKEN || '';
const SERVICE_TOKEN = process.env.MCP_SERVICE_TOKEN || '';

export type McpScope = 'read' | 'deploy' | 'exec';

export interface ActingUser {
  sub: string;
  email?: string;
  externalAuthId?: string;
  sessionId: string;
  scope?: McpScope;
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryInput = Record<string, QueryValue | QueryValue[]> | URLSearchParams;

export function pathSegment(value: unknown): string {
  const raw = String(value);
  if (raw === '.' || raw === '..') {
    throw new Error(`"${raw}" isn't a valid path parameter`);
  }
  return encodeURIComponent(raw);
}

export function path(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0];
  values.forEach((value, index) => {
    out += pathSegment(value) + strings[index + 1];
  });
  return out;
}

export function query(input?: QueryInput): string {
  if (!input) return '';
  if (input instanceof URLSearchParams) {
    const qs = input.toString();
    return qs ? `?${qs}` : '';
  }
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(input)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (value === undefined || value === null || value === '') continue;
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export class OrchardApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string
  ) {
    super(`Orchard API error (${status}): ${detail}`);
  }
}

export class OrchardClient {
  private baseUrl: string;

  private token: string;

  private actingUser?: ActingUser;

  private usesServiceToken: boolean;

  private scopeCap?: McpScope;

  constructor(baseUrl?: string, token?: string, actingUser?: ActingUser, scopeCap?: McpScope) {
    this.baseUrl = (baseUrl || API_URL).replace(/\/$/, '');
    this.actingUser = actingUser;
    this.scopeCap = scopeCap;

    if (actingUser && SERVICE_TOKEN) {
      this.token = SERVICE_TOKEN;
      this.usesServiceToken = true;
    } else {
      this.token = token || API_TOKEN;
      this.usesServiceToken = false;
    }

    if (!this.token) {
      throw new Error(
        'No credential available: set MCP_SERVICE_TOKEN (with acting user) or ORCHARD_API_TOKEN, or pass a token to the constructor'
      );
    }
  }

  get apiBaseUrl(): string {
    return this.baseUrl;
  }

  async request<T = any>(method: string, path: string, body?: any): Promise<T> {
    const url = `${this.baseUrl}/apiv1${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };

    if (this.usesServiceToken && this.actingUser) {
      headers['X-Acting-User-Sub'] = this.actingUser.sub;
      headers['X-Acting-User-Session-Id'] = this.actingUser.sessionId;
      headers['X-Acting-User-Scope'] = this.actingUser.scope ?? 'deploy';
      if (this.actingUser.email) {
        headers['X-Acting-User-Email'] = this.actingUser.email;
      }
      if (this.actingUser.externalAuthId) {
        headers['X-Acting-User-HackClub-Id'] = this.actingUser.externalAuthId;
      }
    } else if (this.scopeCap) {
      headers['X-Acting-User-Scope'] = this.scopeCap;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      let message: string;
      try {
        const json = JSON.parse(text);
        message = json.message || json.error || text;
        if (Array.isArray(message)) message = message.join('; ');
      } catch {
        message = text;
      }
      throw new OrchardApiError(res.status, String(message));
    }

    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text);
    } catch {
      return text as T;
    }
  }

  get<T = any>(path: string) {
    return this.request<T>('GET', path);
  }

  post<T = any>(path: string, body?: any) {
    return this.request<T>('POST', path, body);
  }

  put<T = any>(path: string, body?: any) {
    return this.request<T>('PUT', path, body);
  }

  patch<T = any>(path: string, body?: any) {
    return this.request<T>('PATCH', path, body);
  }

  delete<T = any>(path: string, body?: any) {
    return this.request<T>('DELETE', path, body);
  }
}
