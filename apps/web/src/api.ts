export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('Idempotency-Key', crypto.randomUUID());
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin', cache: 'no-store' }); }
  catch { throw new ApiError(0, 'Cannot reach your workspace. Check the app service and your connection, then try again.'); }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = body as { message?: string; error?: string } | null;
    throw new ApiError(response.status, problem?.message || problem?.error || `Request failed (${response.status}). Please try again.`);
  }
  return body as T;
}
export function post<T>(path: string, body: unknown): Promise<T> { return api<T>(path, { method: 'POST', body: JSON.stringify(body) }); }
