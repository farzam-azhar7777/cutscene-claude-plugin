import { VERSION } from "./config.mjs";
import { collectGitMetadata } from "./git.mjs";
import { CliError, clean, usageError } from "./output.mjs";
import { findSecrets } from "./secrets.mjs";

// Limits from api/openapi.yaml (ContextInput) and SPEC section 6 (context
// <= 20 KB). The body limit is applied in UTF-8 bytes, which also keeps it
// under the 20,000-character schema limit.
const MAX_BODY_BYTES = 20_000;
const MAX_TITLE_LENGTH = 200;
// The server's limit (Context::MAX_METADATA_BYTES, 8 KiB of JSON), measured
// the same way on both sides: UTF-8 bytes of plain JSON (JSON.generate there).
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_METADATA_KEYS = 30;

// Builds the POST /contexts payload from what the user or agent wrote.
// `input` is markdown (an optional leading "# Title" becomes the title) or a
// JSON object { title?, body, metadata? }.
export function buildContext(input, { title, appUrl, git = true, cwd } = {}) {
  const parsed = parseInput(input);

  const finalTitle = (title ?? parsed.title ?? "").trim();
  const body = parsed.body.trim();
  if (!body) throw usageError("The context is empty. Describe what changed and how to see it.");

  const metadata = {
    ...(git ? collectGitMetadata(cwd) : {}),
    ...parsed.metadata,
    plugin_version: VERSION,
  };
  const url = appUrl ?? metadata.app_url;
  if (url !== undefined) metadata.app_url = normaliseAppUrl(url);
  fitChangedFiles(metadata);

  const payload = { ...(finalTitle ? { title: finalTitle } : {}), body, source: "plugin", metadata };
  validate(payload);
  return payload;
}

// A large branch can list more paths than the metadata limit allows. Keep the
// first ones (sorted) and record the full count rather than failing the send.
function fitChangedFiles(metadata) {
  const files = metadata.changed_files;
  if (!Array.isArray(files)) return;
  const total = files.length;
  while (metadata.changed_files.length > 0 && jsonBytes(metadata) > MAX_METADATA_BYTES) {
    metadata.changed_files = metadata.changed_files.slice(0, Math.floor(metadata.changed_files.length * 0.8));
    metadata.changed_files_total = total;
  }
}

function parseInput(input) {
  const text = String(input ?? "").replace(/^\uFEFF/, "");
  const trimmed = text.trim();

  if (trimmed.startsWith("{")) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (error) {
      throw usageError(`The context looks like JSON but does not parse: ${error.message}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw usageError("JSON context must be an object.");
    if (typeof data.body !== "string") throw usageError('JSON context needs a "body" string.');
    if (data.title !== undefined && typeof data.title !== "string") throw usageError('"title" must be a string.');
    if (data.metadata !== undefined && !isPlainObject(data.metadata)) throw usageError('"metadata" must be an object.');
    return { title: data.title, body: data.body, metadata: data.metadata ?? {} };
  }

  const heading = trimmed.match(/^#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/);
  if (heading) return { title: heading[1], body: trimmed.slice(heading[0].length), metadata: {} };
  return { title: undefined, body: trimmed, metadata: {} };
}

// The address a viewer opens to see the change. Only http(s), never with a
// login in it; the fragment is dropped (it never reaches a server anyway).
function normaliseAppUrl(raw) {
  if (typeof raw !== "string") throw usageError("The app URL must be a string.");
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw usageError(`The app URL is not a valid address: "${raw.slice(0, 200)}".`, 'Use the full address, like "http://localhost:3000/billing".');
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw usageError("The app URL must start with http:// or https://.");
  if (url.username || url.password) throw usageError("The app URL must not contain a username or password.");
  url.hash = "";
  return url.href;
}

function validate(payload) {
  const bodyBytes = Buffer.byteLength(payload.body, "utf8");
  if (bodyBytes > MAX_BODY_BYTES) {
    throw usageError(
      `The context is ${bodyBytes.toLocaleString("en-US")} bytes; the limit is ${MAX_BODY_BYTES.toLocaleString("en-US")} (20 KB).`,
      "Shorten it: describe the change and the steps to show, not the code.",
    );
  }
  if (payload.title && payload.title.length > MAX_TITLE_LENGTH) {
    throw usageError(`The title is ${payload.title.length} characters; the limit is ${MAX_TITLE_LENGTH}.`);
  }

  const metadata = payload.metadata;
  if (Object.keys(metadata).length > MAX_METADATA_KEYS) throw usageError(`Metadata can have at most ${MAX_METADATA_KEYS} keys.`);
  if (jsonBytes(metadata) > MAX_METADATA_BYTES) {
    throw usageError(`Metadata is larger than ${MAX_METADATA_BYTES / 1024} KB. Keep it to repo, branch, commit, changed files and the app URL.`);
  }

  const leaks = [
    ...findSecrets(payload.title ?? "").map(({ kind }) => ({ kind, where: "title" })),
    ...findSecrets(payload.body).map(({ kind, line }) => ({ kind, where: `body line ${line}` })),
    ...Object.entries(metadata).flatMap(([key, value]) =>
      findSecrets(`${key}: ${JSON.stringify(value, null, 1)}`).map(({ kind }) => ({ kind, where: `metadata "${clean(key, 64)}"` })),
    ),
  ];
  if (leaks.length > 0) {
    const list = leaks.map(({ kind, where }) => `  ${where}: looks like ${kind}`).join("\n");
    throw new CliError(`Nothing was sent: the context seems to contain a secret.\n${list}`, {
      hint: "Remove it and send again. Cutscene never needs credentials: the extension records in a browser that is already signed in.",
    });
  }
}

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
