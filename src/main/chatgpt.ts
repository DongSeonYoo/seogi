import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { SettingsStore } from "./settings";

/**
 * Sign in with ChatGPT, "ChatGPT plan usage" (developers.openai.com/siwc, open-source preview):
 * the user's own plan pays for summaries and translations, with no key and no qgrid. OAuth with
 * PKCE through the system browser and a loopback callback; each install registers its own client
 * (dynamic_agent_client) and keeps the issued id. Only the Responses API is offered, streamed and
 * unstored, so chatgptFetch reshapes the AI SDK's requests to fit.
 */
const AUTH = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const PORT = 1455;
const SIGN_IN_WAIT_MS = 5 * 60_000;

/** One account's registration and tokens, kept encrypted with the API keys. */
export type ChatGPTAccount = {
  clientId: string;
  hostId: string;
  email: string;
  sub: string;
  accessToken: string;
  refreshToken: string;
  /** ms since epoch. */
  expiresAt: number;
  scope: string;
};

export function chatgptAccount(store: SettingsStore): ChatGPTAccount | null {
  const raw = store.secret("chatgpt");
  return raw ? (JSON.parse(raw) as ChatGPTAccount) : null;
}
const save = (store: SettingsStore, a: ChatGPTAccount | null) => store.setKey("chatgpt", a ? JSON.stringify(a) : "");

const b64url = (b: Buffer) => b.toString("base64url");
const claims = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

type TokenResponse = { access_token: string; refresh_token?: string; id_token?: string; token_type: string; expires_in: number; scope?: string };

async function token(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${AUTH}/api/accounts/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...body, resource: RESOURCE }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ChatGPT sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
  if (String(json.token_type).toLowerCase() !== "bearer") throw new Error("ChatGPT sign-in returned an unexpected token type.");
  return json;
}

/**
 * Opens the browser to sign in and waits for the loopback callback. The ID token comes straight
 * from the token endpoint over TLS, so its claims are checked (issuer, audience, nonce, expiry)
 * without fetching keys to verify its signature (OpenID Connect Core 3.1.3.7).
 */
export async function signInChatGPT(store: SettingsStore, open: (url: string) => void, appName: string): Promise<ChatGPTAccount> {
  const known = chatgptAccount(store);
  const hostId = known?.hostId ?? `urn:uuid:${randomUUID()}`;
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const { server, port } = await listen();
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  try {
    const url = new URL(`${AUTH}/api/accounts/authorize`);
    const params: Record<string, string> = {
      client_id: known?.clientId ?? "dynamic_agent_client",
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      ext_agent_host_id: hostId,
      ...(known ? { login_hint: known.email } : { agent_name_hint: appName }),
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const callback = waitForCallback(server);
    open(url.toString());
    const q = await callback;
    if (q.get("error")) throw new Error(q.get("error") === "access_denied" ? "Sign-in was cancelled." : `ChatGPT sign-in failed: ${q.get("error")}`);
    const code = q.get("code");
    if (!code || !same(q.get("state") ?? "", state)) throw new Error("ChatGPT sign-in returned an invalid answer.");
    const issued = q.get("client_id");
    const clientId = known?.clientId ?? issued;
    if (!clientId || clientId === "dynamic_agent_client" || !/^[\w-]{1,200}$/.test(clientId) || (issued && issued !== clientId))
      throw new Error("ChatGPT sign-in returned an unexpected app registration.");
    const t = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri });
    const id = claims(t.id_token ?? "");
    const audience = Array.isArray(id.aud) ? id.aud : [id.aud];
    if (id.iss !== AUTH || !audience.includes(clientId) || id.nonce !== nonce || Number(id.exp) * 1000 < Date.now() || !id.sub)
      throw new Error("ChatGPT sign-in returned an invalid identity.");
    const scope = t.scope ?? "";
    if (!scope.split(" ").includes(PLAN_SCOPE)) throw new Error("ChatGPT plan usage was not granted (Plus or Pro is needed).");
    const account: ChatGPTAccount = {
      clientId,
      hostId,
      email: String(id.email ?? ""),
      sub: String(id.sub),
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? "",
      expiresAt: Date.now() + t.expires_in * 1000,
      scope,
    };
    await save(store, account);
    return account;
  } finally {
    server.close();
  }
}

/** The fixed port when free (the documented example), any free one otherwise: only the port may vary. */
function listen(): Promise<{ server: Server; port: number }> {
  const at = (port: number) =>
    new Promise<{ server: Server; port: number }>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
    });
  return at(PORT).catch(() => at(0));
}

function waitForCallback(server: Server): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ChatGPT sign-in timed out.")), SIGN_IN_WAIT_MS);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/auth/callback") return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=utf-8><title>Seogi</title><body style=\"font:16px system-ui;padding:3em\">You can close this tab and return to Seogi.</body>");
      clearTimeout(timer);
      resolve(url.searchParams);
    });
  });
}

/** A fresh access token, refreshed a minute before it lapses; one refresh at a time. */
let refreshing: Promise<string> | undefined;
export function chatgptToken(store: SettingsStore): Promise<string> {
  const a = chatgptAccount(store);
  if (!a) return Promise.reject(new Error(store.t("error.chatgptSignIn")));
  if (a.expiresAt - Date.now() > 60_000) return Promise.resolve(a.accessToken);
  return (refreshing ??= (async () => {
    try {
      const t = await token({ grant_type: "refresh_token", client_id: a.clientId, refresh_token: a.refreshToken });
      if (t.id_token && claims(t.id_token).sub !== a.sub) throw new Error("ChatGPT returned another account.");
      const next = { ...a, accessToken: t.access_token, refreshToken: t.refresh_token ?? a.refreshToken, expiresAt: Date.now() + t.expires_in * 1000, scope: t.scope ?? a.scope };
      await save(store, next);
      return next.accessToken;
    } catch (e) {
      // A refused refresh token (expired, rotated away, disconnected in ChatGPT) needs a new sign-in.
      if (e instanceof Error && /invalid_grant|refresh_token|token_expired/.test(e.message)) {
        await save(store, { ...a, accessToken: "", refreshToken: "", expiresAt: 0 });
        throw new Error(store.t("error.chatgptSignIn"));
      }
      throw e;
    }
  })().finally(() => (refreshing = undefined)));
}

/** Revokes the refresh token (best effort) and forgets the tokens; the registration stays for next time. */
export async function signOutChatGPT(store: SettingsStore) {
  const a = chatgptAccount(store);
  if (!a) return;
  try {
    const config = await (await fetch(`${AUTH}/.well-known/openid-configuration`)).json();
    if (typeof config.revocation_endpoint === "string" && config.revocation_endpoint.startsWith(AUTH))
      await fetch(config.revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: a.refreshToken, token_type_hint: "refresh_token", client_id: a.clientId }),
      });
  } catch (e) {
    console.warn("[seogi] ChatGPT sign-out could not revoke the token:", e);
  }
  await save(store, null);
}

/** The models the plan offers, by slug. */
export async function chatgptModels(store: SettingsStore): Promise<string[]> {
  const res = await fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${await chatgptToken(store)}` } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const json: { models?: { slug: string; visibility?: string }[]; data?: { id: string }[] } = await res.json();
  return json.models ? json.models.filter((m) => m.visibility === "list").map((m) => m.slug) : (json.data ?? []).map((m) => m.id);
}

/** Fields plan usage rejects (preview limitations). */
const UNSUPPORTED = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "previous_response_id",
  "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user"];

type InputItem = { role?: string; content?: string | { type?: string; text?: string }[] };

/**
 * fetch for the AI SDK's OpenAI provider: the plan's bearer token, and each Responses request
 * reshaped to what plan usage takes (streamed, unstored, system text as `instructions`).
 */
export function chatgptFetch(store: SettingsStore): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${await chatgptToken(store)}`);
    let body = init?.body;
    if (typeof body === "string" && String(input).endsWith("/responses")) {
      const b = JSON.parse(body);
      const items: InputItem[] = Array.isArray(b.input) ? b.input : [];
      const system = items.filter((i) => i.role === "system" || i.role === "developer");
      const text = (i: InputItem) => (typeof i.content === "string" ? i.content : (i.content ?? []).map((c) => c.text ?? "").join(""));
      if (system.length) {
        b.instructions = [b.instructions, ...system.map(text)].filter(Boolean).join("\n\n");
        b.input = items.filter((i) => !system.includes(i));
      }
      for (const k of UNSUPPORTED) delete b[k];
      b.store = false;
      b.stream = true;
      body = JSON.stringify(b);
    }
    const res = await fetch(input, { ...init, headers, body });
    if (res.status === 429) throw new Error(store.t("error.chatgptLimit"));
    return res;
  };
}
