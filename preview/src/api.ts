/**
 * The preview's only network access: one same-origin GET of /api/design with the per-launch token. It sends nothing else,
 * has no way to name a file, hash or revision, and there is no code here (or on the server) that could register or approve.
 */
export type DesignResponse =
  | { ok: true; status: "PENDING" | "APPROVED"; revision: number; hash: string; approved: boolean; spec: unknown }
  | { ok: false; code: string; message: string };

let token: string | null = null;

/** Takes the token from the URL fragment once (it is never sent to the server in the URL), then clears the fragment. */
export function initToken(): void {
  const m = /(?:^#|&)token=([A-Za-z0-9_-]{16,128})(?:&|$)/.exec(window.location.hash);
  if (m) {
    token = m[1] ?? null;
    try {
      sessionStorage.setItem("prevue-token", token ?? "");
    } catch {}
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  } else {
    try {
      token = sessionStorage.getItem("prevue-token") || null;
    } catch {}
  }
}

export async function fetchDesign(signal?: AbortSignal): Promise<DesignResponse> {
  if (!token) return { ok: false, code: "no_token", message: "Open the URL printed by `prevue preview`; it contains the access token for this preview." };
  let res: Response;
  try {
    res = await fetch("/api/design", { headers: { "X-Prevue-Token": token }, cache: "no-store", credentials: "omit", signal });
  } catch {
    return { ok: false, code: "unreachable", message: "The preview server is not reachable. Is `prevue preview` still running?" };
  }
  try {
    const body = (await res.json()) as DesignResponse;
    if (body && typeof body === "object" && typeof (body as { ok?: unknown }).ok === "boolean") return body;
  } catch {}
  return { ok: false, code: "bad_response", message: "The preview server returned something unexpected." };
}
