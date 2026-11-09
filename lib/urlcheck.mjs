import http from "node:http";
import https from "node:https";
import { VERSION } from "./config.mjs";
import { clean } from "./output.mjs";

// Checks the demo's pages on this computer before anything is sent: does each
// address load, ask for sign-in, or point at nothing? Only loopback addresses
// are fetched (localhost, *.localhost, 127.x, [::1]); remote ones are reported
// as "not checked". No cookies, no Cutscene token, no proxy: a separate code
// path from api.mjs on purpose. Bodies are read only to spot a <title> and a
// password field, and never printed.

export const MAX_URLS = 25;
// Redirects count too: one check never makes more than 25 requests.
const MAX_REQUESTS = 25;
const CONCURRENCY = 4;
const TIMEOUT_MS = 8000;
// The first request to a dev server can compile the page (Next.js, Rails).
const FIRST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 2048;

// The words the check prints for each class. metadata.pages carries only the
// answered ones (pagesMetadata); the panel skips a page listed there with a
// failure and reads every other page of the start site.
export const CLASSES = Object.freeze({
  loads: "loads",
  needs_sign_in: "needs sign-in",
  redirects: "redirects",
  not_found: "not found",
  server_error: "server error",
  nothing_running: "nothing running",
  no_answer: "no answer",
  blocked_host: "blocked host",
  other: "answers with an error",
  not_checked: "not checked",
  skipped: "skipped",
});

const SIGN_IN_PATH = /(^|\/)(sign_?in|signin|log_?in|login|session|sessions|auth|authenticate|sso|oauth|users\/sign_in|account\/login)(\/|$|\?|\.)/i;
// Opening these with a GET could sign the person out or change data (the same
// list the extension uses before it reads a page).
const RISKY_PATH =
  /(^|[/_.-])(logout|log_out|log-out|sign_?out|sign-out|destroy|delete|unsubscribe|approve|confirm|accept|reject|cancel|send|archive|publish|pay|checkout|verify)([/_.-]|$)/i;
const RISKY_QUERY = /^(token|code|key|signature|sig|otp|secret)$/i;

export function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "::1" || host === "0.0.0.0";
}

// Checks up to 25 addresses. `waitSeconds` > 0 first waits (polling once a
// second) until each local server answers at all, for "start it for me".
export async function checkUrls(rawUrls, { waitSeconds = 0, timeoutMs = TIMEOUT_MS, firstTimeoutMs = FIRST_TIMEOUT_MS } = {}) {
  const unique = [...new Set(rawUrls.map((url) => String(url).trim()).filter(Boolean))];
  const results = unique.slice(0, MAX_URLS).map((raw) => ({ url: raw }));
  const byOrigin = new Map();
  const budget = { left: MAX_REQUESTS };

  for (const result of results) {
    const parsed = parseCheckable(result.url);
    if (parsed.error) {
      Object.assign(result, parsed.error);
      continue;
    }
    result.url = parsed.url.href;
    if (!byOrigin.has(parsed.url.origin)) byOrigin.set(parsed.url.origin, []);
    byOrigin.get(parsed.url.origin).push({ result, url: parsed.url });
  }

  if (waitSeconds > 0) await Promise.all([...byOrigin.values()].map((group) => waitUntilAnswering(group[0].url, waitSeconds)));

  // One origin at a time per first request (it may compile), then the rest
  // of that origin four at a time. A server that is not running answers
  // nothing, so its other pages are not tried.
  await Promise.all(
    [...byOrigin.values()].map(async (group) => {
      const [first, ...rest] = group;
      Object.assign(first.result, await checkOne(first.url, firstTimeoutMs, budget));
      if (first.result.class === "nothing_running" || first.result.class === "blocked_host") {
        for (const item of rest) Object.assign(item.result, { class: first.result.class, label: first.result.label });
        return;
      }
      await pool(rest, CONCURRENCY, async (item) => Object.assign(item.result, await checkOne(item.url, timeoutMs, budget)));
    }),
  );
  return { results, dropped: Math.max(0, unique.length - MAX_URLS) };
}

function parseCheckable(raw) {
  if (raw.length > MAX_URL_LENGTH) return { error: { class: "not_checked", label: "not checked (the address is too long)" } };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: { class: "not_checked", label: "not checked (not a web address)" } };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: { class: "not_checked", label: "not checked (not a web address)" } };
  if (url.username || url.password) return { error: { class: "not_checked", label: "not checked (the address has a login in it)" } };
  url.hash = "";
  if (!isLoopbackHost(url.hostname)) return { url, error: { class: "not_checked", label: "not checked (not on this computer)" } };
  const risky = RISKY_PATH.test(url.pathname) || [...url.searchParams.keys()].some((key) => RISKY_QUERY.test(key));
  if (risky) return { url, error: { class: "skipped", label: "not checked (opening it could sign out or change data)" } };
  return { url };
}

async function checkOne(url, timeoutMs, budget = { left: MAX_REQUESTS }) {
  const started = Date.now();
  let current = url;
  for (let hop = 0; ; hop += 1) {
    if (budget.left <= 0) return { class: "not_checked", label: `not checked (one check makes at most ${MAX_REQUESTS} requests)` };
    budget.left -= 1;
    const answer = await request(current, timeoutMs);
    if (answer.error) return { ...describeFailure(answer.error, current, timeoutMs), ms: Date.now() - started };

    const { status } = answer;
    const base = { status, ms: Date.now() - started };
    if (status >= 300 && status < 400 && answer.location) {
      let target;
      try {
        target = new URL(answer.location, current);
      } catch {
        return { ...base, class: "redirects", label: "redirects to an address that does not parse" };
      }
      const where = target.origin === url.origin ? `${target.pathname}${target.search}` : target.origin;
      base.location = target.href;
      if (SIGN_IN_PATH.test(target.pathname)) return { ...base, class: "needs_sign_in", label: `needs sign-in (redirects to ${clean(where, 120)})` };
      if (target.origin !== url.origin || !isLoopbackHost(target.hostname)) {
        return { ...base, class: "redirects", label: `redirects to ${clean(where, 120)} (another site, not followed)` };
      }
      if (hop >= MAX_REDIRECTS) return { ...base, class: "redirects", label: `redirects more than ${MAX_REDIRECTS} times` };
      if (target.href === current.href) return { ...base, class: "redirects", label: "redirects to itself" };
      current = target;
      continue;
    }

    const via = current.href === url.href ? "" : ` after redirecting to ${clean(`${current.pathname}${current.search}`, 120)}`;
    if (current.href !== url.href) base.location = current.href;
    const title = answer.title ? ` ("${clean(answer.title, 80)}")` : "";
    if (status >= 200 && status < 300) {
      if (answer.passwordField && !SIGN_IN_PATH.test(current.pathname)) {
        return { ...base, class: "needs_sign_in", label: `needs sign-in (shows a sign-in form${via})` };
      }
      return { ...base, class: "loads", label: `loads${title}${via}`, title: answer.title };
    }
    if (status === 401) return { ...base, class: "needs_sign_in", label: `needs sign-in (HTTP 401${via})` };
    if (status === 403) {
      if (answer.blockedHost) return { ...base, class: "blocked_host", label: `blocked host: the dev server does not allow ${current.host}. Use the address it allows.` };
      return { ...base, class: "needs_sign_in", label: `needs sign-in or another role (HTTP 403${via})` };
    }
    if (status === 404 || status === 410) return { ...base, class: "not_found", label: `not found (HTTP ${status}${via})` };
    if (status >= 500) return { ...base, class: "server_error", label: `server error (HTTP ${status}${via})` };
    return { ...base, class: "other", label: `answers HTTP ${status}${via}` };
  }
}

function describeFailure(error, url, timeoutMs) {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (error === "timeout") return { class: "no_answer", label: `no answer in ${Math.round(timeoutMs / 1000)} seconds` };
  if (error === "ECONNREFUSED") return { class: "nothing_running", label: `nothing is running on port ${port}` };
  return { class: "no_answer", label: `no answer (${clean(error, 40)})` };
}

// One GET. Never follows redirects, never sends cookies or credentials.
function request(url, timeoutMs, { retryIpv4 = true } = {}) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // *.localhost and 0.0.0.0 are this computer; connect to it directly and
  // keep the name in the Host header (dev servers check it).
  const connectTo = host === "0.0.0.0" || host.endsWith(".localhost") ? "127.0.0.1" : host;
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = transport.request(
      {
        host: connectTo,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        // A local dev server's self-signed certificate is fine here: nothing
        // secret is sent and the answer is only classified.
        rejectUnauthorized: false,
        servername: connectTo === host && !/^[\d.:]+$/.test(host) ? host : undefined,
        headers: {
          Host: url.host,
          "User-Agent": `cutscene-plugin/${VERSION} (page check)`,
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        if (status >= 300 && status < 400) {
          res.resume();
          finish({ status, location });
          req.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        const done = () => {
          const body = Buffer.concat(chunks).toString("utf8");
          finish({
            status,
            title: pageTitle(body),
            passwordField: /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(body),
            blockedHost: status === 403 && /blocked host|not allowed\. to allow|is not allowed/i.test(body),
          });
        };
        res.on("data", (chunk) => {
          size += chunk.length;
          chunks.push(chunk);
          if (size >= MAX_BODY_BYTES) {
            done();
            req.destroy();
          }
        });
        res.on("end", done);
        res.on("error", done);
      },
    );
    const timer = setTimeout(() => {
      finish({ error: "timeout" });
      req.destroy();
    }, timeoutMs);
    req.on("error", (error) => {
      if (settled) return;
      // Node 18 tries only one address for "localhost"; try IPv4 once.
      if (retryIpv4 && host === "localhost" && (error.code === "ECONNREFUSED" || error.code === "EADDRNOTAVAIL")) {
        clearTimeout(timer);
        settled = true;
        const ipv4 = new URL(url.href);
        ipv4.hostname = "127.0.0.1";
        request(ipv4, timeoutMs, { retryIpv4: false }).then((answer) => resolve(answer));
        return;
      }
      finish({ error: error.code ?? error.message ?? "error" });
    });
    req.end();
  });
}

function pageTitle(body) {
  const match = body.match(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i);
  if (!match) return null;
  const text = match[1]
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

async function waitUntilAnswering(url, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const answer = await request(url, Math.min(5000, Math.max(500, deadline - Date.now())));
    if (!answer.error || answer.error === "timeout") return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function pool(items, size, work) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  });
  await Promise.all(workers);
}

// "5 pages load. 1 page needs sign-in." for the summary Claude shows.
export function summarizePages(results) {
  const count = (cls) => results.filter((result) => result.class === cls).length;
  const parts = [];
  const plural = (n, one, many) => (n === 1 ? one : many.replace("#", String(n)));
  const loads = count("loads");
  if (loads) parts.push(plural(loads, "1 page loads.", "# pages load."));
  const redirects = count("redirects");
  if (redirects) parts.push(plural(redirects, "1 page redirects somewhere else.", "# pages redirect somewhere else."));
  const signIn = count("needs_sign_in");
  if (signIn) parts.push(plural(signIn, "1 page needs sign-in.", "# pages need sign-in."));
  const notFound = count("not_found");
  if (notFound) parts.push(plural(notFound, "1 page is not found.", "# pages are not found."));
  const serverError = count("server_error") + count("other");
  if (serverError) parts.push(plural(serverError, "1 page answers with an error.", "# pages answer with an error."));
  const nothing = results.filter((result) => result.class === "nothing_running");
  if (nothing.length) {
    const hosts = [...new Set(nothing.map((result) => new URL(result.url).host))];
    parts.push(`Nothing is running at ${hosts.join(" or ")}.`);
  }
  const noAnswer = count("no_answer");
  if (noAnswer) parts.push(plural(noAnswer, "1 page did not answer.", "# pages did not answer."));
  const blocked = count("blocked_host");
  if (blocked) parts.push(plural(blocked, "1 page is on a host the dev server blocks.", "# pages are on a host the dev server blocks."));
  const remote = results.filter((result) => result.class === "not_checked" && /not on this computer/.test(result.label)).length;
  if (remote) parts.push(plural(remote, "1 page is not on this computer, so it was not checked.", "# pages are not on this computer, so they were not checked."));
  const skipped = count("skipped");
  if (skipped) parts.push(plural(skipped, "1 page was not opened because it could sign out or change data.", "# pages were not opened because they could sign out or change data."));
  if (signIn) parts.push("If Chrome is not signed in there, Cutscene asks you to sign in before it writes.");
  return parts.join(" ");
}

// The answers a page check can be sure of. Everything else (not on this
// computer, over the request budget, not opened because it could change
// data, nothing running yet, no answer) says nothing about the page.
const ANSWERED = new Set(["loads", "needs_sign_in", "redirects", "not_found", "server_error", "other", "blocked_host"]);

// metadata.pages: "<url> <class>" strings (plain strings, so older servers
// keep them when they flatten metadata for the writer), only for pages the
// check got an answer from. A page left out was never checked: the panel
// reads it like notes without a check (production, staging, a dev server
// started after the check). Empty when nothing answered: leave the key out.
export const pagesMetadata = (results) =>
  results.filter((result) => ANSWERED.has(result.class)).map((result) => `${result.url} ${CLASSES[result.class]}`);
