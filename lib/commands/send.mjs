import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { UnreachableError, apiError, apiRequest, signedOutError } from "../api.mjs";
import { openInChrome } from "../browser.mjs";
import { expandHome, isSkillNotesPath, notesDir, siteFor } from "../config.mjs";
import { ensurePrivateDir } from "../credentials.mjs";
import { buildContext, finalizeContext, urlsIn } from "../context.mjs";
import { lastSentFor, loadDraft, recordSent, removeDraft, saveDraft } from "../drafts.mjs";
import { CliError, EXIT, clean, note, printJson, say, usageError } from "../output.mjs";
import { checkUrls, pagesMetadata, summarizePages } from "../urlcheck.mjs";
import { requireCredentials } from "./shared.mjs";

export const spec = {
  help: "boolean",
  json: "boolean",
  "dry-run": "boolean",
  draft: "string",
  update: "boolean",
  title: "string",
  body: "string",
  file: "string",
  "notes-file": "string",
  "app-url": "string",
  "no-git": "boolean",
  "no-check": "boolean",
  "no-open": "boolean",
  "idempotency-key": "string",
};

export const help = `Send demo notes to Cutscene. They open in the Cutscene side panel in
Chrome, ready for Write script.

Usage
  cutscene send --dry-run < notes.md     Check and save a draft; send nothing
  cutscene send --dry-run --notes-file <path>
                                         The same, from the notes file the
                                         Claude Code skill saved
  cutscene send --draft <id>             Send exactly that draft
  cutscene send < notes.md               Check and send in one go

Input
  Markdown: a first line "# Title" becomes the title, the rest is the body.
  JSON: { "title": "...", "body": "...", "metadata": { ... } }
  The body can be at most 20 KB.

Options
  --dry-run                 Save a draft (kept 24 hours) and print its id and
                            what it holds; send nothing
  --draft <id>              Send the draft a dry run saved, byte for byte
  --update                  These notes replace the ones this Claude Code
                            session sent before (same demo, updated)
  --title <text>            Title (overrides the one in the input)
  --body <text>             Body text instead of stdin
  --file <path>             Read the input from a file ("-" for stdin)
  --notes-file <path>       Read the notes the Claude Code skill saved in
                            ~/.config/cutscene/notes, then delete that file
                            (the draft keeps them)
  --app-url <url>           Where the demo starts (default: the first
                            "Start at:" address in the notes)
  --no-git                  Do not attach repo, branch, commit and changed files
  --no-check                Do not check the notes' local pages
  --no-open                 After sending, do not open Chrome
  --idempotency-key <key>   Reuse a key to make a retried send count once
  --json                    Print the result as JSON

Before saving or sending, the addresses in the notes that are on this
computer are checked (loads, needs sign-in, not found, ...); the result for
each page that answered goes with the notes. The repo name, branch, commit
and changed file paths of the current git checkout are attached (never file
contents or diffs). A dry run prints all of it ("Also sent: ...").
Sending stops if the text looks like it contains a password, key or token.

After sending, Chrome opens on the demo's start page and the Cutscene panel
picks the notes up; the last line says what to press.`;

const MAX_INPUT_BYTES = 1024 * 1024;
const ATTEMPTS = 3;
const HANDOFF_WAIT_SECONDS = 6;
const STORE_URL = "https://chromewebstore.google.com/detail/cutscene/bheofgkkeaedknlnkaejmlgdimmphcbd";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTEXT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function run(flags) {
  if (flags.draft !== undefined) {
    const extra = ["dry-run", "update", "title", "body", "file", "notes-file", "app-url", "no-git", "no-check"].filter((name) => flags[name] !== undefined);
    if (extra.length) throw usageError(`--draft sends the draft as it is; it cannot be combined with --${extra[0]}.`);
    return sendDraft(flags);
  }

  const sessionId = currentSessionId();
  let updatesContextId = null;
  if (flags.update) {
    updatesContextId = lastSentFor(sessionId)?.context_id ?? null;
    if (!updatesContextId) note("This Claude Code session has not sent notes before, so these go as a new demo.");
  }

  const payload = buildContext(await readInput(flags), {
    title: flags.title,
    appUrl: flags["app-url"],
    git: !flags["no-git"],
    sessionId,
    updatesContextId,
  });
  let pages = [];
  if (!flags["no-check"]) {
    const { results } = await checkUrls(urlsIn(payload.body, payload.metadata.app_url));
    pages = results;
    // Only pages that answered; none answered (production, nothing running
    // yet) leaves the key out, so the panel reads the pages itself.
    const answered = pagesMetadata(results);
    if (answered.length) payload.metadata.pages = answered;
    else delete payload.metadata.pages;
    finalizeContext(payload);
  }

  const text = JSON.stringify(payload);
  if (flags["dry-run"]) {
    const id = saveDraft(text);
    if (flags.json) {
      printJson({ draft: id, payload, pages: pages.map(({ url, label }) => ({ url, label })), summary: summarizePages(pages) });
    } else {
      showDraft(id, payload, pages);
    }
    return EXIT.ok;
  }
  return deliver(text, payload, flags, { key: idempotencyKey(flags["idempotency-key"]) });
}

async function sendDraft(flags) {
  const text = loadDraft(flags.draft);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CliError(`Draft ${flags.draft} is damaged.`, { hint: 'Run "cutscene send --dry-run" again.' });
  }
  if (!payload || typeof payload !== "object" || typeof payload.body !== "string" || !payload.metadata || typeof payload.metadata !== "object") {
    throw new CliError(`Draft ${flags.draft} is damaged.`, { hint: 'Run "cutscene send --dry-run" again.' });
  }
  // The same limits and secret check as when it was made; the bytes sent
  // are the draft's own.
  finalizeContext(structuredClone(payload));
  const key = flags["idempotency-key"] !== undefined ? idempotencyKey(flags["idempotency-key"]) : `draft-${flags.draft}`;
  const code = await deliver(text, payload, flags, { key });
  if (code === EXIT.ok) removeDraft(flags.draft);
  return code;
}

function showDraft(id, payload, pages) {
  const { metadata } = payload;
  const bytes = Buffer.byteLength(payload.body, "utf8");
  const chapters = (payload.body.match(/^###\s+\d+[.)]/gm) ?? []).length;
  const steps = (payload.body.match(/^\s*\d+[.)]\s+\S/gm) ?? []).length;
  say(`draft ${id}`);
  say(`Title: ${payload.title ? clean(payload.title, 200) : "(none)"}`);
  say(`Notes: ${bytes.toLocaleString("en-US")} bytes of 20,000${chapters ? `, ${chapters} ${chapters === 1 ? "chapter" : "chapters"}` : ""}${steps ? `, ${steps} numbered ${steps === 1 ? "line" : "lines"}` : ""}`);
  say(`Start at: ${metadata.app_url ? clean(metadata.app_url, 300) : "(no start address)"}`);
  if (pages.length) {
    say("Pages:");
    for (const page of pages) say(`  ${clean(page.url, 300)}: ${page.label}`);
    say(summarizePages(pages));
  }
  for (const line of alsoSent(metadata)) say(line);
  say(`Nothing was sent. To send exactly this: cutscene send --draft ${id}`);
}

// Everything that goes with the notes besides the title, the text and the
// start address, in words: one "Also sent" line for the summary, then the
// full list of changed file names, so the person can read every detail
// before choosing Send.
export function alsoSent(metadata) {
  const lines = [];
  const items = [];
  if (metadata.repo) items.push(`repo ${clean(metadata.repo, 200)}`);
  if (metadata.branch) items.push(`branch ${clean(metadata.branch, 200)}`);
  if (metadata.commit) items.push(`commit ${clean(String(metadata.commit), 64).slice(0, 7)}`);
  const files = Array.isArray(metadata.changed_files) ? metadata.changed_files : [];
  const total = Number.isInteger(metadata.changed_files_total) ? metadata.changed_files_total : files.length;
  if (files.length) {
    const names = files.length === 1 ? "changed file name" : "changed file names";
    items.push(total > files.length ? `${files.length} of ${num(total)} ${names}` : `${files.length} ${names}`);
  }
  const skipped = skippedWords(metadata.changed_files_skipped);
  if (skipped) items.push(`a count of files left out (${skipped})`);
  if (Array.isArray(metadata.pages) && metadata.pages.length) {
    items.push(`the page check of ${metadata.pages.length} ${metadata.pages.length === 1 ? "page" : "pages"}`);
  }
  if (metadata.session_id) items.push("an id for this Claude Code session");
  if (metadata.updates_context_id) items.push("which notes it replaces");
  const known = new Set(["repo", "branch", "commit", "changed_files", "changed_files_total", "changed_files_skipped", "pages", "session_id", "updates_context_id", "app_url", "plugin_version"]);
  const other = Object.keys(metadata).filter((key) => !known.has(key));
  if (other.length) items.push(`${other.length === 1 ? "the field" : "the fields"} ${other.map((key) => clean(key, 40)).join(", ")}`);
  if (metadata.plugin_version) items.push("the plugin version");
  if (items.length) lines.push(`Also sent: ${listWords(items)}.`);
  if (files.length) {
    lines.push("Changed file names sent (names only, never their contents):");
    for (const file of files) lines.push(`  ${clean(String(file), 300)}`);
  }
  if (metadata.updates_context_id) lines.push("Replaces the notes this session sent before (same demo, updated).");
  return lines;
}

const num = (n) => n.toLocaleString("en-US");
const listWords = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// { images: 180, lockfiles: 3 } -> "180 images, 3 lockfiles"
const SKIPPED_WORDS = {
  images: ["image", "images"],
  media: ["media file", "media files"],
  fonts: ["font", "fonts"],
  lockfiles: ["lockfile", "lockfiles"],
  vendor: ["vendored file", "vendored files"],
  "build output": ["build output file", "build output files"],
  "system files": ["system file", "system files"],
  "binary files": ["binary file", "binary files"],
};
function skippedWords(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.entries(value)
    .filter(([, count]) => Number.isInteger(count) && count > 0)
    .map(([kind, count]) => {
      const [one, many] = SKIPPED_WORDS[kind] ?? [`${clean(kind, 40)} file`, `${clean(kind, 40)} files`];
      return `${num(count)} ${count === 1 ? one : many}`;
    })
    .join(", ");
}

// POSTs the exact bytes, then hands the notes to Chrome and reports where
// they are.
async function deliver(text, payload, flags, { key }) {
  const credentials = requireCredentials();
  const site = siteFor(credentials);
  const response = await postContext(site, credentials.token, text, key);

  if (response.status === 401) throw signedOutError();
  if (response.status === 413) throw new CliError("Cutscene says the notes are too large. Shorten them and send again.");
  if (response.status === 422) throw new CliError(`Cutscene did not accept the notes: ${apiError(response).message}`);
  if (response.status === 429) throw new CliError("Too many notes sent in a short time. Wait a minute, then send again.");
  if (response.status < 200 || response.status >= 300) throw new CliError(`Could not send the notes: ${apiError(response).message}`);

  const context = response.data ?? {};
  if (typeof context.id !== "string" || !CONTEXT_ID.test(context.id)) throw new CliError("Cutscene stored the notes but answered in an unexpected format.");
  recordSent(payload.metadata?.session_id, context.id, payload.title);

  const handoff = await handOff({ site, token: credentials.token, context, payload, noOpen: Boolean(flags["no-open"]) });
  const who = credentials.email ? clean(credentials.email, 320) : "your Cutscene account";
  const message = handoffMessage({ ...handoff, who, update: Boolean(payload.metadata?.updates_context_id), start: startOf(payload), goUrl: handoff.handoffUrl });
  if (flags.json) {
    printJson({ context, handoff_url: handoff.handoffUrl, opened: handoff.opened, handoff_state: handoff.state, message });
  } else {
    say(message);
  }
  return EXIT.ok;
}

// Where the notes go next:
// - no extension on the account: open the Chrome Web Store page;
// - a go link (new server and extension): open it; the extension takes the
//   notes to the panel and the start page; then ask the server for up to 6 s
//   what the panel did (shown, needs_icon, waiting, busy);
// - otherwise (older server or extension): open the start page.
async function handOff({ site, token, context, payload, noOpen }) {
  const start = startOf(payload);
  const handoffUrl = goLink(context.handoff_url, site, context.id);
  const result = { handoffUrl, opened: false, how: null, state: null, kind: "icon", start };
  if (context.extension_connected === false) {
    result.kind = "install";
    if (!noOpen) Object.assign(result, pick(await openInChrome(STORE_URL)));
    return result;
  }
  const target = handoffUrl ?? start;
  if (noOpen || !target) {
    result.kind = target ? "open-yourself" : "no-start";
    return result;
  }
  Object.assign(result, pick(await openInChrome(target)));
  if (!result.opened) {
    result.kind = "open-yourself";
    return result;
  }
  if (handoffUrl) result.state = await waitForPanel(site, token, context.id);
  return result;
}

const pick = ({ opened, how }) => ({ opened, how });

async function waitForPanel(site, token, id) {
  let state = null;
  for (let second = 1; second <= HANDOFF_WAIT_SECONDS; second += 1) {
    await sleep(1000);
    let response;
    try {
      response = await apiRequest(site, "GET", `/contexts/${encodeURIComponent(id)}`, { token, timeoutMs: 3000 });
    } catch {
      return state;
    }
    // An older server does not let the plugin read notes back: stop asking.
    if (response.status !== 200) return state;
    const value = response.data?.handoff_state;
    state = typeof value === "string" ? value : null;
    if (["shown", "needs_icon", "waiting", "busy"].includes(state)) return state;
  }
  return state;
}

// The go link is used only when it is on Cutscene's own site and names these
// notes; anything else is ignored.
function goLink(raw, site, id) {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.origin !== site || url.username || url.password || url.search || url.hash) return null;
    return url.pathname === `/go/${id}` ? url.href : null;
  } catch {
    return null;
  }
}

function startOf(payload) {
  const raw = payload.metadata?.app_url;
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || raw.length > 2048) return null;
    return url.href;
  } catch {
    return null;
  }
}

// "localhost:3000/practices" for reading; the full address when the person
// has to open it.
const shortUrl = (href) => {
  const url = new URL(href);
  const rest = `${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  return `${url.host}${rest}`;
};

// The extension's own shortcut (extension/wxt.config.ts: MacCtrl+Shift+C on
// macOS, Alt+Shift+C elsewhere).
const shortcut = (platform) => (platform === "darwin" ? "Control+Shift+C" : "Alt+Shift+C");

export function handoffMessage({ kind, state, who, update, start, goUrl = null, platform = process.platform }) {
  const sent = update ? `Sent the update to ${who}.` : `Sent to ${who}.`;
  const key = shortcut(platform);
  if (kind === "install") {
    return `${sent} Install the Cutscene Chrome extension: ${STORE_URL}. Then press its icon${start ? ` on ${shortUrl(start)}` : ""} and Write script.`;
  }
  if (kind === "no-start") return `${sent} In Chrome, open your app, press the Cutscene icon (or ${key}), then Write script.`;
  if (kind === "open-yourself") {
    // No start page in the notes: the go link still carries them to the panel.
    const where = start ?? goUrl;
    if (!where) return `${sent} In Chrome, open your app, press the Cutscene icon (or ${key}), then Write script.`;
    return `${sent} In Chrome, open ${where}, press the Cutscene icon (or ${key}), then Write script.`;
  }
  if (state === "shown") return `${sent} It is open in the Cutscene panel in Chrome: press Write script and the demo writes and records itself.`;
  if (state === "needs_icon") return `${sent} It is open in the Cutscene panel. Press the Cutscene icon (or ${key}) on that tab once so it can record there, then Write script.`;
  if (state === "waiting") return `${sent} Your notes are waiting in the Cutscene panel: press Show.`;
  if (state === "busy") return `${sent} Cutscene is recording another demo. Your new notes show in the panel when it ends.`;
  if (!start) return `${sent} Press the Cutscene icon in Chrome's toolbar (or ${key}), then Write script.`;
  return `${sent} Chrome is open at ${shortUrl(start)}. Press the Cutscene icon in the toolbar (or ${key}), then Write script.`;
}

function currentSessionId() {
  const value = process.env.CLAUDE_CODE_SESSION_ID;
  return typeof value === "string" && UUID.test(value.trim()) ? value.trim().toLowerCase() : null;
}

// Retries network failures, 5xx and 429 with the same Idempotency-Key, so a
// send whose answer was lost is stored once, not twice.
async function postContext(site, token, text, key) {
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt === ATTEMPTS;
    try {
      const response = await apiRequest(site, "POST", "/contexts", {
        token,
        rawBody: text,
        headers: { "Idempotency-Key": key },
      });
      const retryable = response.status >= 500 || (response.status === 429 && (response.retryAfter ?? 1) <= 10);
      if (!retryable || last) return response;
      await sleep(Math.max(attempt * 1000, (response.retryAfter ?? 0) * 1000));
    } catch (error) {
      if (!(error instanceof UnreachableError) || last) throw error;
      await sleep(attempt * 1000);
    }
  }
}

function idempotencyKey(custom) {
  if (custom === undefined) return crypto.randomUUID();
  if (!/^[\x21-\x7e]{1,100}$/.test(custom)) throw usageError("--idempotency-key must be 1 to 100 visible ASCII characters.");
  return custom;
}

async function readInput(flags) {
  const sources = [flags.body !== undefined, flags.file !== undefined, flags["notes-file"] !== undefined].filter(Boolean).length;
  if (sources > 1) throw usageError("Use only one of --body, --file and --notes-file.");
  if (flags.body !== undefined) return flags.body;
  if (flags["notes-file"] !== undefined) return readNotesFile(flags["notes-file"]);
  if (flags.file !== undefined && flags.file !== "-") return readFile(flags.file);
  if (process.stdin.isTTY) {
    throw usageError("No notes given.", 'Pipe them in ("cutscene send --dry-run < notes.md"), or use --file, --notes-file or --body.');
  }
  return readStdin();
}

function readFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    throw usageError(`Could not read ${clean(file, 300)} (${error.code ?? "unreadable"}).`);
  }
  if (!stat.isFile()) throw usageError(`${clean(file, 300)} is not a file.`);
  if (stat.size > MAX_INPUT_BYTES) throw usageError(`${clean(file, 300)} is larger than 1 MB; notes are at most 20 KB.`);
  return fs.readFileSync(file, "utf8");
}

// The skill's hand-off file: only <config dir>/notes/<name>.md, a regular
// file (never a link), read once and deleted, so notes never pile up on disk.
// The draft (0600, 24 hours) is what --draft sends.
function readNotesFile(file) {
  const resolved = path.resolve(expandHome(file));
  if (!isSkillNotesPath(resolved)) {
    throw usageError(`--notes-file reads only the notes file the Cutscene skill saves (got ${clean(file, 300)}).`, "Use --file for any other file.");
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    throw usageError(`Could not read ${clean(file, 300)} (${error.code ?? "unreadable"}).`, "Save the notes with the Write tool, then run the dry run again.");
  }
  if (!stat.isFile()) throw usageError(`${clean(file, 300)} is not a file.`);
  if (stat.size > MAX_INPUT_BYTES) {
    fs.rmSync(resolved, { force: true });
    throw usageError(`${clean(file, 300)} is larger than 1 MB; notes are at most 20 KB.`);
  }
  const text = fs.readFileSync(resolved, "utf8");
  fs.rmSync(resolved, { force: true });
  // The Write tool makes missing folders with default modes; keep ours private.
  if (path.dirname(resolved) === notesDir()) ensurePrivateDir("notes");
  return text;
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw usageError("The input is larger than 1 MB; notes are at most 20 KB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
