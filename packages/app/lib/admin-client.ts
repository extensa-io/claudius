"use client";

/**
 * Tiny client-side JSON caller for the admin panels. Normalizes the app's error
 * envelope ({ error: { message } }) into a flat result the components can branch
 * on without repeating fetch boilerplate.
 */
export type SendResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export async function sendJson(
  path: string,
  method: string,
  body?: unknown,
): Promise<SendResult> {
  try {
    const init: RequestInit = {
      method,
      headers: { "content-type": "application/json" },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(path, init);
    const data = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    if (!res.ok) {
      return { ok: false, error: data?.error?.message ?? "Action failed." };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: "Network error." };
  }
}
