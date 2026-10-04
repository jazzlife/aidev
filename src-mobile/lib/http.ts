/**
 * Used by every sheet that changes something on the server: the server's own wording for a failed request (C-12 rule:
 * shown as is), or "실패했습니다 (상태코드)" when it has none. Reads `details`, `error` (text or {message, details})
 * and `message`, the shapes the runtime's routes answer with.
 */
export async function failureText(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown; details?: unknown; message?: unknown } | null;
  const error = body?.error && typeof body.error === 'object' ? body.error as { message?: unknown; details?: unknown } : null;
  for (const candidate of [body?.details, typeof body?.error === 'string' ? body.error : null, error?.details, error?.message, body?.message]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return `실패했습니다 (${response.status})`;
}

/** Throws the server's wording unless the response is ok; returns the parsed body. */
export async function okJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await failureText(response));
  return await response.json().catch(() => ({})) as T;
}
