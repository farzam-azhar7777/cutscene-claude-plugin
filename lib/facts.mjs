// Session facts for /cutscene:demo: a digest of this Claude Code session's
// transcript (what the person asked, what Claude said it built, the files it
// changed, the commands it ran) plus git facts, dev-server hints and the
// Cutscene sign-in state. Read on this computer only, and printed into the
// skill so Claude can write complete demo notes; nothing here is sent.
//
// Privacy: tool outputs, file contents and diffs are never printed (only
// commands, file paths and pass or fail), code blocks in Claude's messages are
// left out, and any line that looks like a secret is dropped.
//
//   node lib/facts.mjs --session <uuid> --project <dir> [--transcript <file>]
//
// Always exits 0: a failing `!` command would abort the whole skill.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, configDir, isSkillNotesPath, notesFileFor } from "./config.mjs";
import { loadCredentials } from "./credentials.mjs";
import { KIND_LABELS, gitFacts } from "./git.mjs";
import { clean } from "./output.mjs";
import { findSecrets } from "./secrets.mjs";

export const MAX_CHARS = 24_000;
const MAX_TRANSCRIPT_BYTES = 120 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const SOFT_DEADLINE_MS = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function sessionIdFrom(arg, env = process.env) {
  for (const value of [arg, env.CLAUDE_CODE_SESSION_ID]) {
    if (typeof value === "string" && UUID.test(value.trim())) return value.trim().toLowerCase();
  }
  return null;
}

export function projectDirFrom(arg, env = process.env) {
  for (const value of [arg, env.CLAUDE_PROJECT_DIR]) {
    if (typeof value === "string" && value.trim() && !value.includes("${") && isDirectory(value.trim())) return path.resolve(value.trim());
  }
  return process.cwd();
}

// <config>/projects/<slug>/<session>.jsonl; the slug is the project path with
// every other character as "-", but searching all folders is safer.
export function findTranscript(sessionId, projectDir, env = process.env) {
  const base = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  const slug = projectDir.replace(/[^A-Za-z0-9]/g, "-");
  const first = path.join(base, slug, `${sessionId}.jsonl`);
  if (isFile(first)) return first;
  let folders = [];
  try {
    folders = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const candidate = path.join(base, folder, `${sessionId}.jsonl`);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

// Streams the JSONL (newest 120 MB at most), one JSON.parse per line, and
// keeps only what the digest prints.
export function digestTranscript(file, projectDir) {
  const digest = {
    lines: 0,
    unreadable: 0,
    compactions: 0,
    title: null,
    prompts: [],
    answers: [],
    reports: [],
    summaries: [],
    edited: new Map(),
    commands: [],
    urls: new Map(),
    truncated: false,
    tooSlow: false,
  };
  const toolUses = new Map();
  const started = Date.now();
  let turn = 0;
  let lastReport = null;

  const onLine = (line) => {
    digest.lines += 1;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      digest.unreadable += 1;
      return;
    }
    if (!entry || typeof entry !== "object") return;
    const at = typeof entry.timestamp === "string" ? entry.timestamp : null;

    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") digest.title = entry.aiTitle;
    if (entry.type === "system" && entry.subtype === "compact_boundary") digest.compactions += 1;
    if (entry.isSidechain) return;

    if (entry.type === "user") {
      const content = entry.message?.content;
      if (entry.isCompactSummary) {
        const text = textOf(content);
        if (text) digest.summaries.push({ at, text });
        return;
      }
      // Tool results: only whether they failed, and the answers to questions.
      const results = Array.isArray(content) ? content.filter((block) => block?.type === "tool_result") : [];
      for (const result of results) {
        const use = toolUses.get(result.tool_use_id);
        if (use?.command) use.command.failed = Boolean(result.is_error) || Boolean(entry.toolUseResult?.interrupted);
      }
      const answers = entry.toolUseResult?.answers;
      if (answers && typeof answers === "object") {
        for (const [question, answer] of Object.entries(answers)) digest.answers.push({ at, question: String(question), answer: String(answer) });
      }
      if (results.length > 0 || entry.isMeta || entry.toolUseResult) return;

      const typed = typedPrompt(content);
      if (!typed) return;
      if (lastReport) digest.reports.push(lastReport);
      lastReport = null;
      turn += 1;
      digest.prompts.push({ at, text: typed });
      collectUrls(digest.urls, typed, at);
      return;
    }

    if (entry.type === "assistant") {
      for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          // The last text of a turn is Claude's own account of what it did.
          lastReport = { at, turn, text: block.text };
          collectUrls(digest.urls, block.text, at);
        } else if (block?.type === "tool_use") {
          const use = { name: block.name };
          toolUses.set(block.id, use);
          const input = block.input ?? {};
          if (EDIT_TOOLS.has(block.name)) {
            // The skill's own notes file is not part of the app.
            const target = input.file_path ?? input.notebook_path;
            const file = isSkillNotesPath(target) ? null : relativePath(target, projectDir);
            if (file) digest.edited.set(file, (digest.edited.get(file) ?? 0) + 1);
          } else if (block.name === "Bash" && typeof input.command === "string") {
            use.command = { at, ...classifyCommand(input.command), background: Boolean(input.run_in_background), failed: null };
            digest.commands.push(use.command);
            collectUrls(digest.urls, input.command, at);
          }
        }
      }
    }
  };

  readLines(file, onLine, () => {
    if (Date.now() - started > SOFT_DEADLINE_MS) {
      digest.tooSlow = true;
      return false;
    }
    return true;
  }, digest);
  if (lastReport) digest.reports.push(lastReport);
  return digest;
}

// Edited paths from this session's subagents (their own transcripts).
export function subagentEdits(file, projectDir, edited) {
  const dir = path.join(path.dirname(file), path.basename(file, ".jsonl"), "subagents");
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).slice(0, 50);
  } catch {
    return 0;
  }
  for (const name of names) {
    readLines(path.join(dir, name), (line) => {
      if (!line.includes('"tool_use"')) return;
      try {
        const entry = JSON.parse(line);
        for (const block of entry.message?.content ?? []) {
          if (block?.type === "tool_use" && EDIT_TOOLS.has(block.name)) {
            const rel = relativePath(block.input?.file_path ?? block.input?.notebook_path, projectDir);
            if (rel) edited.set(rel, (edited.get(rel) ?? 0) + 1);
          }
        }
      } catch {
        // Skip a damaged line.
      }
    });
  }
  return names.length;
}

function readLines(file, onLine, keepGoing = () => true, digest = null) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    let position = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
    let skipFirst = position > 0;
    if (skipFirst && digest) digest.truncated = true;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let rest = "";
    while (position < size) {
      const read = fs.readSync(fd, buffer, 0, Math.min(CHUNK_BYTES, size - position), position);
      if (read <= 0) break;
      position += read;
      const text = rest + buffer.toString("utf8", 0, read);
      const lines = text.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        if (skipFirst) {
          skipFirst = false;
          continue;
        }
        if (line.trim()) onLine(line);
      }
      if (!keepGoing()) return;
    }
    if (rest.trim() && !skipFirst) onLine(rest);
  } finally {
    fs.closeSync(fd);
  }
}

// A prompt the person typed: plain text, without system reminders, local
// command output or task notifications. Slash commands become "/name args".
function typedPrompt(content) {
  const raw = textOf(content);
  if (!raw) return null;
  const command = raw.match(/<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/);
  if (command) {
    const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? "";
    const name = command[1].startsWith("/") ? command[1] : `/${command[1]}`;
    return `${name}${args ? ` ${args}` : ""}`;
  }
  const text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(local-command-[a-z]+|task-notification|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g, "")
    .trim();
  if (!text || text.startsWith("<") || /^\[Request interrupted/.test(text)) return null;
  return text;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

const TEST_COMMAND =
  /\b(rspec|rails test|bin\/rails test|rake test|pytest|py\.test|jest|vitest|mocha|ava|npm (run )?test|yarn test|pnpm (run )?test|bun test|go test|cargo test|mix test|phpunit|pest|playwright test|cypress run|node --test|deno test|dotnet test)\b/;
const SERVER_COMMAND =
  /\b(rails s|rails server|bin\/rails s|bin\/rails server|bin\/dev|foreman start|overmind start|npm (run )?(dev|start|serve|preview)|yarn (dev|start|serve)|pnpm (run )?(dev|start|serve)|bun (run )?dev|next dev|vite( dev| preview)?|nuxt dev|astro dev|ng serve|python3? manage\.py runserver|uvicorn|gunicorn|flask run|php artisan serve|mix phx\.server|hugo server|jekyll serve|\.\/start\.sh|node (--watch[^ ]* )*[^ ]*server[^ ]*\.m?js)\b/;

export function classifyCommand(command) {
  const lines = command.split("\n");
  // Only the first line: a heredoc body can be a whole file.
  const first = lines[0].replace(/\s+/g, " ").trim();
  const shown = first.length > 200 ? `${first.slice(0, 199)}…` : first;
  let kind = "other";
  if (/\bgit commit\b/.test(first)) kind = "commit";
  else if (TEST_COMMAND.test(first)) kind = "test";
  else if (SERVER_COMMAND.test(first)) kind = "server";
  const port = portIn(first);
  return { kind, text: shown, more: lines.length > 1, port, message: kind === "commit" ? commitSubject(command) : null };
}

// The subject line of a commit message: -m "..." or the first line of a
// heredoc (git commit -m "$(cat <<'EOF' ... EOF)").
function commitSubject(command) {
  const heredoc = command.match(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\b/);
  const body = heredoc ? heredoc[2] : command.match(/-m\s+(["'])([\s\S]*?)\1/)?.[2];
  const subject = body?.split("\n").map((line) => line.trim()).find(Boolean);
  return subject ? subject.slice(0, 160) : null;
}

function portIn(text) {
  const match = text.match(/(?:\bPORT=|--port[= ]|\s-p\s?|localhost:|127\.0\.0\.1:|0\.0\.0\.0:)(\d{2,5})\b/);
  return match ? Number(match[1]) : null;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>()[\]{}|\\^]+|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})(?:\/[^\s"'`<>()[\]{}|\\^]*)?/g;

function collectUrls(urls, text, at) {
  for (const match of String(text).matchAll(URL_PATTERN)) {
    let url = match[0].replace(/[.,;:!?]+$/, "");
    if (!/^https?:/.test(url)) url = `http://${url}`;
    // Shell or template placeholders ("/invoices/$id") are not addresses.
    if (url.length > 300 || /[$`]|%24|%7B|\{|\}/i.test(url)) continue;
    urls.set(url, at ?? urls.get(url) ?? null);
  }
}

function relativePath(file, projectDir) {
  if (typeof file !== "string" || !file) return null;
  const absolute = path.resolve(projectDir, file);
  const rel = path.relative(projectDir, absolute);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : absolute.replace(os.homedir(), "~");
}

// Dev-server hints from the project's own files: the command and the port.
export function devServerHints(projectDir) {
  const hints = [];
  const pkg = readJson(path.join(projectDir, "package.json"));
  if (pkg?.scripts && typeof pkg.scripts === "object") {
    for (const name of ["dev", "start", "serve", "preview", "develop"]) {
      const script = pkg.scripts[name];
      if (typeof script !== "string") continue;
      const port = portIn(` ${script}`) ?? defaultPort(script);
      hints.push(`package.json "${name}": ${clean(script, 160)}${port ? ` (port ${port})` : ""}`);
    }
  }
  for (const name of ["Procfile.dev", "Procfile"]) {
    const text = readText(path.join(projectDir, name));
    if (!text) continue;
    for (const line of text.split("\n").filter((l) => /^\s*web\s*:/.test(l)).slice(0, 2)) {
      const port = portIn(` ${line}`) ?? (/rails/.test(line) ? 3000 : null);
      hints.push(`${name}: ${clean(line.trim(), 160)}${port ? ` (port ${port})` : ""}`);
    }
  }
  if (isFile(path.join(projectDir, "bin", "dev"))) {
    const puma = readText(path.join(projectDir, "config", "puma.rb"));
    const port = puma?.match(/port\s+ENV\.fetch\(\s*["']PORT["']\s*,?\s*(?:\{\s*)?(\d{2,5})/)?.[1] ?? (isFile(path.join(projectDir, "config", "routes.rb")) ? "3000" : null);
    hints.push(`bin/dev${port ? ` (port ${port})` : ""}`);
  }
  for (const name of ["start.sh", "bin/start", "bin/server"]) {
    const text = readText(path.join(projectDir, name));
    const port = text?.match(/PORT:-(\d{2,5})|PORT=(\d{2,5})|localhost:(\d{2,5})/);
    if (text) hints.push(`${name}${port ? ` (port ${port[1] ?? port[2] ?? port[3]})` : ""}`);
  }
  if (isFile(path.join(projectDir, "manage.py"))) hints.push("manage.py runserver (port 8000)");
  if (isFile(path.join(projectDir, "artisan"))) hints.push("php artisan serve (port 8000)");
  return hints.slice(0, 8);
}

function defaultPort(script) {
  if (/\bnext\b/.test(script)) return 3000;
  if (/\bvite\b/.test(script)) return /preview/.test(script) ? 4173 : 5173;
  if (/\bastro\b/.test(script)) return 4321;
  if (/\bnuxt\b/.test(script)) return 3000;
  if (/\bng serve\b/.test(script)) return 4200;
  if (/react-scripts start/.test(script)) return 3000;
  if (/rails s|rails server/.test(script)) return 3000;
  return null;
}

function signInState(env = process.env) {
  try {
    const credentials = loadCredentials();
    if (!credentials) return "Not signed in to Cutscene on this computer yet: the first send asks to sign in (a code to approve in Chrome).";
    const who = credentials.email ? ` as ${clean(credentials.email, 320)}` : "";
    const site = env.CUTSCENE_URL && env.CUTSCENE_URL.replace(/\/+$/, "") !== credentials.url ? ` (CUTSCENE_URL is ${clean(env.CUTSCENE_URL, 200)})` : "";
    return `Signed in to Cutscene${who} at ${credentials.url}${site}. Not checked online.`;
  } catch {
    return "The saved Cutscene sign-in on this computer is damaged: the send will ask to sign in again.";
  }
}

function lastSent(sessionId) {
  if (!sessionId) return null;
  const data = readJson(path.join(configDir(), "last-sent.json"));
  const entry = data?.sessions?.[sessionId];
  return entry && typeof entry.context_id === "string" ? entry : null;
}

// ---------- rendering ----------

function stripCode(text) {
  return String(text)
    .replace(/```[\s\S]*?(```|$)/g, "[code left out]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cut(text, max) {
  const value = clean(text, 100_000).trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

const when = (at) => {
  if (!at) return "";
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

// Indented lines without the ones that look like secrets (counted).
let secretLines = 0;
function quoteBlock(text) {
  return text
    .split("\n")
    .filter((line) => {
      if (findSecrets(line).length === 0) return true;
      secretLines += 1;
      return false;
    })
    .map((line) => `  ${line}`)
    .join("\n");
}

// "- <when>\n  <text>", or nothing when every line of it was dropped.
function entry(at, text) {
  const body = quoteBlock(text);
  return body.trim() ? `- ${when(at)}\n${body}` : "";
}

// Adds entries (newest first) while they fit in `budget` characters.
function fill(entries, budget, render) {
  const out = [];
  let used = 0;
  let left = 0;
  for (const item of entries) {
    const text = render(item);
    if (!text) continue;
    if (used + text.length + 1 > budget) {
      left += 1;
      continue;
    }
    out.push(text);
    used += text.length + 1;
  }
  return { out, left };
}

export function renderFacts({ sessionId, projectDir, transcript, digest, git, hints, signIn, sent, missingReason, subagents }) {
  const head = ["## Session facts (read on this computer by the Cutscene plugin; nothing here is sent)", ""];
  if (missingReason) {
    head.push(`Transcript: ${missingReason} Use the conversation and the git facts below.`);
  } else {
    const bits = [`${digest.lines.toLocaleString("en-US")} lines`, `${digest.prompts.length} typed requests`];
    if (digest.compactions) bits.push(`compacted ${digest.compactions} ${digest.compactions === 1 ? "time" : "times"} (the earlier messages are still here)`);
    if (subagents) bits.push(`${subagents} subagent ${subagents === 1 ? "transcript" : "transcripts"}`);
    if (digest.truncated) bits.push("only the newest 120 MB read");
    if (digest.tooSlow) bits.push("stopped reading early (took too long)");
    head.push(`Transcript: ${bits.join(", ")}. Newest first in every list.${digest.title ? ` Session title: "${cut(digest.title, 120)}".` : ""}`);
  }
  head.push(`Project: ${projectDir.replace(os.homedir(), "~")}`);
  head.push("");

  // Small, bounded sections first; the person's words and Claude's reports
  // share what is left.
  const small = [];
  if (digest) {
    const files = [...digest.edited.entries()].sort((a, b) => b[1] - a[1]);
    if (files.length) {
      const { out, left } = fill(files, 1500, ([file, count]) => `- ${file}${count > 1 ? ` (${count} edits)` : ""}`);
      small.push("### Files Claude changed in this session", ...out, ...(left ? [`- and ${left} more`] : []), "");
    }
    const commands = [...digest.commands].reverse();
    const notable = commands.filter((c) => c.kind !== "other");
    // Reading commands (cat, grep, ls, git diff, ...) say little about what was built.
    const reading = /^(cat|grep|rg|ls|head|tail|sed -n|find|echo|wc|pwd|which|tree|git (diff|status|log|show|branch))\b/;
    const other = commands.filter((c) => c.kind === "other" && !reading.test(c.text) && !/\/bin\/cutscene/.test(c.text)).slice(0, 12);
    if (notable.length || other.length) {
      const label = { test: "tests", server: "dev server", commit: "git commit", other: "ran" };
      const render = (c) => {
        const result = c.kind === "test" ? (c.failed === true ? " (failed)" : c.failed === false ? " (passed)" : "") : c.kind === "server" && c.background ? " (in the background)" : "";
        if (c.kind === "commit" && c.message) return `- git commit: "${cut(c.message, 140)}"`;
        return `- ${label[c.kind]}: \`${c.text}\`${c.more ? " (more lines)" : ""}${result}${c.port && c.kind === "server" ? `, port ${c.port}` : ""}`;
      };
      const { out } = fill([...notable, ...other], 1800, render);
      small.push("### Commands Claude ran", ...out, "");
    }
    const urls = [...digest.urls.entries()].sort((a, b) => String(b[1] ?? "").localeCompare(String(a[1] ?? "")));
    const local = urls.filter(([url]) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|[^/]*\.localhost)/.test(url));
    const remote = urls.filter(([url]) => !local.some(([l]) => l === url));
    if (urls.length) {
      const { out, left } = fill([...local, ...remote], 1200, ([url]) => `- ${url}`);
      small.push("### Addresses seen in this session", ...out, ...(left ? [`- and ${left} more`] : []), "");
    }
    if (digest.answers.length) {
      const { out } = fill([...digest.answers].reverse(), 1500, (a) => `- "${cut(a.question, 200)}" = "${cut(a.answer, 300)}"`);
      small.push("### Questions the person answered", ...out, "");
    }
  }

  if (git) {
    small.push("### Repository");
    small.push(`- ${git.repo}${git.branch ? `, branch ${git.branch}` : ", no branch (detached)"}${git.commit ? `, commit ${git.commit.slice(0, 7)}` : ""}`);
    if (git.base) small.push(`- Base: ${git.base.ref} at ${git.base.sha.slice(0, 7)}; ${git.uncommitted} uncommitted ${git.uncommitted === 1 ? "file" : "files"}`);
    if (git.commits.length) {
      const { out } = fill(git.commits, 1200, (c) => `- commit ${c.sha} ${cut(c.subject, 150)}`);
      small.push(...out);
    }
    const editedHere = digest?.edited ?? new Map();
    const ranked = git.ranked.map((file) => ({ ...file, here: editedHere.has(file.path) }));
    if (ranked.length) {
      small.push(`- Changed files, most useful for a demo first (${git.total} in all):`);
      const { out, left } = fill(ranked, 2200, (f) => `  - ${f.path} (${KIND_LABELS[f.kind]}${f.churn ? `, ${f.churn} lines` : ""}${f.here ? ", changed in this session" : ""})`);
      small.push(...out, ...(left ? [`  - and ${left} more`] : []));
    } else {
      small.push("- No changed files against the base.");
    }
    const skipped = Object.entries(git.skipped);
    if (skipped.length) small.push(`- Not listed: ${skipped.map(([kind, count]) => `${count} ${kind}`).join(", ")}`);
    small.push("");
  } else {
    small.push("### Repository", "- Not a git repository (or git is not installed).", "");
  }

  small.push("### Dev server");
  small.push(...(hints.length ? hints.map((hint) => `- ${hint}`) : ["- No dev server command found in package.json, Procfile.dev, bin/dev or start.sh."]));
  small.push("");
  small.push("### Cutscene");
  small.push(`- ${signIn}`, `- Plugin ${VERSION}.`, `- Notes file for the dry run: ${notesFileFor(sessionId)}`);
  if (sent) small.push(`- Sent from this session before: notes ${sent.context_id}${sent.at ? ` at ${when(sent.at)}` : ""}${sent.title ? ` ("${cut(sent.title, 120)}")` : ""}. Send changes to the same demo with --update.`);
  small.push("");

  const smallText = small.join("\n");
  const big = [];
  if (digest && !missingReason) {
    let room = MAX_CHARS - head.join("\n").length - smallText.length - 400;
    const promptBudget = Math.max(2000, Math.floor(room * 0.55));
    const prompts = [...digest.prompts].reverse();
    const p = fill(prompts, promptBudget, (x) => entry(x.at, cut(x.text, 2500)));
    if (prompts.length) big.push("### What the person asked", ...p.out, ...(p.left ? [`- and ${p.left} older requests (left out for length)`] : []), "");
    room -= big.join("\n").length;

    const reports = [...digest.reports].reverse();
    const summary = digest.summaries.at(-1);
    const r = fill(reports, Math.max(1500, room - (summary ? 2600 : 0)), (x) => entry(x.at, cut(stripCode(x.text), 1500)));
    if (reports.length) big.push("### What Claude said it did (code left out)", ...r.out, ...(r.left ? [`- and ${r.left} older messages (left out for length)`] : []), "");
    if (summary) big.push("### Summary of the earlier conversation (from the newest compaction)", quoteBlock(cut(stripCode(summary.text), 2400)), "");
  }

  return finish([...head, ...big, smallText].join("\n"));
}

// Drops lines that look like secrets and keeps the whole under 24,000 chars.
function finish(text) {
  const lines = text.split("\n");
  let dropped = secretLines;
  secretLines = 0;
  const kept = lines.filter((line) => {
    if (findSecrets(line).length === 0) return true;
    dropped += 1;
    return false;
  });
  if (dropped) kept.push(`(${dropped} ${dropped === 1 ? "line was" : "lines were"} left out because ${dropped === 1 ? "it looks" : "they look"} like a password, key or token.)`);
  let out = kept.join("\n").trimEnd();
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS - 40);
    out = `${out.slice(0, out.lastIndexOf("\n"))}\n(cut here for length)`;
  }
  return `${out}\n`;
}

export function collectFacts({ session, project, transcript: transcriptArg, env = process.env } = {}) {
  const projectDir = projectDirFrom(project, env);
  const sessionId = sessionIdFrom(session, env);
  let digest = null;
  let missingReason = null;
  let subagents = 0;
  let file = transcriptArg ?? null;
  if (!file) {
    if (!sessionId) missingReason = "no session id was given, so the conversation could not be read.";
    else file = findTranscript(sessionId, projectDir, env);
    if (sessionId && !file) missingReason = "this session's transcript is not on disk yet (it is written after the first message of a session).";
  }
  if (file && !missingReason) {
    try {
      digest = digestTranscript(file, projectDir);
      subagents = subagentEdits(file, projectDir, digest.edited);
      if (digest.lines === 0) missingReason = "the transcript is empty.";
    } catch (error) {
      missingReason = `the transcript could not be read (${clean(error.code ?? error.message, 60)}).`;
      digest = null;
    }
  }
  let git = null;
  try {
    git = gitFacts(projectDir);
  } catch {
    git = null;
  }
  return renderFacts({
    sessionId,
    projectDir,
    digest: missingReason ? null : digest,
    git,
    hints: devServerHints(projectDir),
    signIn: signInState(env),
    sent: lastSent(sessionId),
    missingReason,
    subagents,
  });
}

function parseArgv(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--session" || name === "--project" || name === "--transcript") {
      out[name.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return out;
}

function readJson(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let output;
  try {
    output = collectFacts(parseArgv(process.argv.slice(2)));
  } catch (error) {
    output = `Session facts unavailable: ${clean(error?.message ?? error, 200)}. Use the conversation and git.\n`;
  }
  process.stdout.write(output);
  process.exitCode = 0;
}
