import crypto from "node:crypto";
import fs from "node:fs";
import { UnreachableError, apiError, apiRequest, signedOutError } from "../api.mjs";
import { siteFor } from "../config.mjs";
import { buildContext } from "../context.mjs";
import { CliError, EXIT, clean, dim, note, printJson, say, usageError } from "../output.mjs";
import { requireCredentials } from "./shared.mjs";

export const spec = {
  help: "boolean",
  json: "boolean",
  "dry-run": "boolean",
  title: "string",
  body: "string",
  file: "string",
  "app-url": "string",
  "no-git": "boolean",
  "idempotency-key": "string",
};

export const help = `Send demo context to Cutscene. It waits in the Cutscene side panel
in Chrome, marked "From Claude Code".

Usage
  cutscene send < context.md
  cutscene send --file context.json
  cutscene send --title "Invoice export" --body "..." --app-url http://localhost:3000

Input
  Markdown: a first line "# Title" becomes the title, the rest is the body.
  JSON: { "title": "...", "body": "...", "metadata": { ... } }
  The body can be at most 20 KB.

Options
  --title <text>            Title (overrides the one in the input)
  --body <text>             Body text instead of stdin
  --file <path>             Read the input from a file ("-" for stdin)
  --app-url <url>           Where a viewer opens the change
  --no-git                  Do not attach repo, branch, commit and changed files
  --dry-run                 Print exactly what would be sent; send nothing
  --idempotency-key <key>   Reuse a key to make a retried send count once
  --json                    Print the stored context as JSON

The repo name, branch, commit and changed file paths of the current git
checkout are attached as metadata (never file contents or diffs). Sending
stops if the text looks like it contains a password, key or token.`;

const MAX_INPUT_BYTES = 1024 * 1024;
const ATTEMPTS = 3;

export async function run(flags) {
  const payload = buildContext(await readInput(flags), {
    title: flags.title,
    appUrl: flags["app-url"],
    git: !flags["no-git"],
  });

  if (flags["dry-run"]) {
    printJson(payload);
    note(dim("Dry run: nothing was sent."));
    return EXIT.ok;
  }

  const credentials = requireCredentials();
  const site = siteFor(credentials);
  const key = idempotencyKey(flags["idempotency-key"]);
  const response = await postContext(site, credentials.token, payload, key);

  if (response.status === 401) throw signedOutError();
  if (response.status === 413) throw new CliError("Cutscene says the context is too large. Shorten it and send again.");
  if (response.status === 422) throw new CliError(`Cutscene did not accept the context: ${apiError(response).message}`);
  if (response.status === 429) throw new CliError("Too many contexts sent in a short time. Wait a minute, then send again.");
  if (response.status < 200 || response.status >= 300) throw new CliError(`Could not send the context: ${apiError(response).message}`);

  const context = response.data ?? {};
  if (typeof context.id !== "string") throw new CliError("Cutscene stored the context but answered in an unexpected format.");

  if (flags.json) {
    printJson(context);
  } else {
    const title = typeof context.title === "string" && context.title ? clean(context.title, 200) : null;
    say(title ? `Sent "${title}" to Cutscene.` : "Sent the context to Cutscene.");
    say('Open the Cutscene side panel in Chrome: it is waiting there, marked "From Claude Code".');
  }
  return EXIT.ok;
}

// Retries network failures, 5xx and 429 with the same Idempotency-Key, so a
// send whose answer was lost is stored once, not twice.
async function postContext(site, token, payload, key) {
  for (let attempt = 1; ; attempt += 1) {
    const last = attempt === ATTEMPTS;
    try {
      const response = await apiRequest(site, "POST", "/contexts", {
        token,
        body: payload,
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
  const sources = [flags.body !== undefined, flags.file !== undefined].filter(Boolean).length;
  if (sources > 1) throw usageError("Use either --body or --file, not both.");
  if (flags.body !== undefined) return flags.body;
  if (flags.file !== undefined && flags.file !== "-") return readFile(flags.file);
  if (process.stdin.isTTY) {
    throw usageError("No context given.", 'Pipe it in ("cutscene send < context.md"), or use --file or --body.');
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
  if (stat.size > MAX_INPUT_BYTES) throw usageError(`${clean(file, 300)} is larger than 1 MB; a context is at most 20 KB.`);
  return fs.readFileSync(file, "utf8");
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw usageError("The input is larger than 1 MB; a context is at most 20 KB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
