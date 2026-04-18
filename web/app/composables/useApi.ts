/** Reactive API client for Subbrain backend */
export function useApi() {
  const config = useRuntimeConfig();
  const token = useState<string | null>("api-token", () => null);

  const base = config.public.apiBase || "";

  async function fetchToken() {
    const data = await $fetch<{ token: string }>(`${base}/api/token`);
    token.value = data.token;
    return data.token;
  }

  async function ensureToken() {
    if (!token.value) await fetchToken();
    return token.value!;
  }

  async function api<T = unknown>(
    path: string,
    opts: Parameters<typeof $fetch>[1] = {},
  ): Promise<T> {
    const t = await ensureToken();
    return $fetch<T>(`${base}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        ...((opts.headers as Record<string, string>) || {}),
      },
    });
  }

  /** Raw fetch (for streaming) */
  async function rawFetch(
    path: string,
    opts: RequestInit = {},
  ): Promise<Response> {
    const t = await ensureToken();
    return fetch(`${base}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        ...((opts.headers as Record<string, string>) || {}),
      },
    });
  }

  return { token, fetchToken, ensureToken, api, rawFetch };
}
