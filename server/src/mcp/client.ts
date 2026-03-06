const API_URL = process.env.ORCHARD_API_URL || 'http://localhost:3001';
const API_TOKEN = process.env.ORCHARD_API_TOKEN || '';

export class OrchardClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl?: string, token?: string) {
    this.baseUrl = (baseUrl || API_URL).replace(/\/$/, '');
    this.token = token || API_TOKEN;
    if (!this.token) {
      throw new Error('ORCHARD_API_TOKEN environment variable is required (or pass token to constructor)');
    }
  }

  private async request<T = any>(
    method: string,
    path: string,
    body?: any,
  ): Promise<T> {
    const url = `${this.baseUrl}/apiv1${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
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
