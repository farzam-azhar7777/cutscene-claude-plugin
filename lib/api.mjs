import os from "node:os";
import { VERSION } from "./config.mjs";
import { CliError, EXIT, clean } from "./output.mjs";

const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class UnreachableError extends CliError {
  constructor(site, cause) {
    super(describeNetworkFailure(site, cause), { exitCode: EXIT.unreachable });
  }
}

// One JSON request to /api/v1. Returns { status, data, retryAfter } for any
// HTTP answer and throws UnreachableError when there is none. Redirects are
// not followed: the API never redirects, and following one could carry the
// bearer token to another address.
export async function apiRequest(site, method, path, { token, body, headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  const requestHeaders = {
    Accept: "application/json",
    "User-Agent": `cutscene-plugin/${VERSION} (node ${process.versions.node}; ${os.platform()})`,
    ...headers,
  };
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  if (token) requestHeaders.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${site}/api/v1${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new UnreachableError(site, error);
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new CliError(`${site} answered with a redirect (HTTP ${response.status}) instead of the Cutscene API.`, {
      hint: "Check that CUTSCENE_URL is the Cutscene site address itself.",
    });
  }

  const text = await readCapped(response, site);
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: response.status, data, retryAfter: retryAfterSeconds(response.headers.get("retry-after")) };
}

// The server's { error: { code, message } }, cleaned for the terminal. An
// answer that is not in that shape is never echoed (it could be anything a
// proxy or another server sent).
export function apiError(response) {
  const error = response.data?.error;
  const code = typeof error?.code === "string" ? clean(error.code, 60) : null;
  const message = typeof error?.message === "string" && error.message.trim() ? clean(error.message, 300) : null;
  return { code, message: message ?? `Cutscene answered with HTTP ${response.status}.` };
}

export const signedOutError = () =>
  new CliError("Your Cutscene sign-in is no longer valid (it was revoked or has expired).", {
    exitCode: EXIT.signedOut,
    hint: 'Run "cutscene login" to sign in again.',
  });

async function readCapped(response, site) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CliError(`${site} sent an unexpectedly large answer. Check CUTSCENE_URL.`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new UnreachableError(site, error);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function retryAfterSeconds(header) {
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 300) : null;
}

function describeNetworkFailure(site, error) {
  if (error?.name === "TimeoutError") return `${site} did not answer within ${TIMEOUT_MS / 1000} seconds. Try again in a moment.`;
  const code = error?.cause?.code ?? error?.code;
  switch (code) {
    case "ECONNREFUSED":
      return `Could not connect to Cutscene at ${site} (connection refused). Is the web app running?`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `Could not find ${site}. Check your internet connection and CUTSCENE_URL.`;
    case "ECONNRESET":
    case "UND_ERR_SOCKET":
      return `The connection to ${site} dropped. Try again in a moment.`;
    default:
      if (typeof code === "string" && /CERT|SSL|TLS/i.test(code)) {
        return `Could not make a secure connection to ${site} (${clean(code, 60)}). The site's certificate is not trusted.`;
      }
      return `Could not reach Cutscene at ${site}${code ? ` (${clean(code, 60)})` : ""}.`;
  }
}
