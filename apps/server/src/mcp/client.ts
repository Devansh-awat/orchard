const API_URL = process.env.ORCHARD_API_URL || 'http://localhost:3001';
const API_TOKEN = process.env.ORCHARD_API_TOKEN || '';
const SERVICE_TOKEN = process.env.MCP_SERVICE_TOKEN || '';

export interface ActingUser {
  sub: string;
  email?: string;
  externalAuthId?: string;
  sessionId: string;
}

export class OrchardClient {
  private baseUrl: string;

  private token: string;

  private actingUser?: ActingUser;

  private usesServiceToken: boolean;

  constructor(baseUrl?: string, token?: string, actingUser?: ActingUser) {
    this.baseUrl = (baseUrl || API_URL).replace(/\/$/, '');
    this.actingUser = actingUser;

    // Gateway mode: when the MCP server holds a shared service credential and
    // we have a validated acting user from the MCP JWT, authenticate to the
    // Orchard API as the service and pass the user identity in trusted
    // headers. This keeps the M-2 invariant (a type='mcp' JWT can never be
    // replayed at the first-party API) while still letting MCP tool calls
    // act on behalf of the consenting user.
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

  private async request<T = any>(method: string, path: string, body?: any): Promise<T> {
    const url = `${this.baseUrl}/apiv1${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };

    if (this.usesServiceToken && this.actingUser) {
      headers['X-Acting-User-Sub'] = this.actingUser.sub;
      headers['X-Acting-User-Session-Id'] = this.actingUser.sessionId;
      if (this.actingUser.email) {
        headers['X-Acting-User-Email'] = this.actingUser.email;
      }
      if (this.actingUser.externalAuthId) {
        headers['X-Acting-User-HackClub-Id'] = this.actingUser.externalAuthId;
      }
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    if (!res.ok) {
      const text = await res.text();
      let message: string;
      try {
        const json = JSON.parse(text);
        message = json.message || json.error || text;
      } catch {
        message = text;
      }
      throw new Error(`Orchard API error (${res.status}): ${message}`);
    }

    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text);
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

  delete<T = any>(path: string) {
    return this.request<T>('DELETE', path);
  }
}
