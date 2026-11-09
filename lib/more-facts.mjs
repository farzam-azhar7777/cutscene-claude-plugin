// More facts than fit in the skill prompt, written to two files in the CLI's config folder (folder 0700, files
// 0600, this computer only, never sent), which the skill reads with Read in its first batch of reads:
//   <config>/facts/<session>-session.md : the newest compaction summary in full, Claude's reports (newest 30),
//                                         the person's requests (newest 60)
//   <config>/facts/<session>-screens.md : every changed screen file (routes, views, components, pages, locales,
//                                         front-end scripts, controllers) by folder, and the words each one adds
//                                         on screen (labels, headings, messages), from its added lines
// Each file stays under 70,000 characters (the Read tool's limit per call is about 25,000 tokens). Lines that look
// like a password, key or token are dropped. Both files are deleted after a send (removeSessionFiles), and any
// facts or notes file older than 24 hours is deleted on every run (pruneSessionFiles).
import fs from "node:fs";
import path from "node:path";
import { configDir, notesDir, notesFileFor } from "./config.mjs";
import { classifyPath, git } from "./git.mjs";
import { findSecrets } from "./secrets.mjs";

const MAX_FILE = 70_000;
const SCREEN_KINDS = new Set(["routes", "views", "locales", "controllers", "js"]);

const stripCode = (t) => String(t ?? "").replace(/```[\s\S]*?(```|$)/g, "[code left out]").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
const cut = (t, n) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const when = (at) => (at ? `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "");
const noSecrets = (text) => text.split("\n").filter((l) => findSecrets(l).length === 0).join("\n");

function fill(lines, budget) {
  const out = []; let used = 0; let left = 0;
  for (const l of lines) { if (used + l.length + 1 > budget) { left += 1; continue; } out.push(l); used += l.length + 1; }
  return { out, left };
}

export function sessionFile(digest) {
  const parts = ["# More session facts (read on this computer by the Cutscene plugin; nothing here is sent)", ""];
  const summary = digest.summaries.at(-1);
  if (summary) parts.push("## Summary of the earlier conversation (newest compaction, in full)", cut(stripCode(summary.text), 24_000), "");
  const reports = [...digest.reports].reverse().slice(0, 30).map((r) => `- ${when(r.at)}\n  ${cut(stripCode(r.text), 3000).replace(/\n/g, "\n  ")}`);
  const r = fill(reports, 28_000);
  parts.push("## What Claude said it did, newest first (code left out)", ...r.out, ...(r.left ? [`- and ${r.left} more (left out for length)`] : []), "");
  const docs = [...(digest.docs ?? [])].reverse().slice(0, 4);
  if (docs.length) {
    parts.push("## Documents Claude wrote in this session (newest first, first 5,000 characters, code left out)");
    for (const d of docs) parts.push(`- ${d.file} (${when(d.at)})`, "  " + cut(stripCode(d.text), 5000).replace(/\n/g, "\n  "));
    parts.push("");
  }
  const prompts = [...digest.prompts].reverse().slice(0, 60).map((p) => `- ${when(p.at)}\n  ${cut(stripCode(p.text), 1500).replace(/\n/g, "\n  ")}`);
  const room = MAX_FILE - parts.join("\n").length - 200;
  const p = fill(prompts, Math.max(2000, room));
  parts.push("## What the person asked, newest first", ...p.out, ...(p.left ? [`- and ${p.left} more (left out for length)`] : []), "");
  return noSecrets(parts.join("\n")).slice(0, MAX_FILE);
}

// Words a viewer may see, from one added line of a template, component, page, locale or script.
const WORDS = [
  />\s*([^<>{}\n]*[A-Za-z][^<>{}\n]*?)\s*</g, // text between tags
  /(?:aria-label|title|placeholder|alt|label|data-confirm|data-turbo-confirm|confirm|notice|alert|value)\s*[:=]\s*["']([^"'\n]{2,120})["']/g,
  /\b(?:t|I18n\.t|link_to|button_to|button|submit|label|link|h|toast|flash|notice|alert|confirm)\s*\(?\s*["']([^"'\n]{2,120})["']/g,
  /^\s*[\w.-]+:\s*["']?([^"'\n#][^"'\n]{1,160})["']?\s*$/g, // locale yml values
  /["']([A-Z][^"'\n]{2,100})["']/g, // any capitalised quoted phrase
];
const IDS = /\b(?:id|name|data-testid|data-action|data-controller|data-[\w-]+-target|aria-controls|href)\s*[:=]\s*["']([^"'\n]{2,80})["']/g;
function wordsIn(line) {
  const found = new Set();
  for (const re of WORDS) for (const m of line.matchAll(re)) {
    const w = m[1].trim().replace(/\s+/g, " ");
    if (w.length < 2 || w.length > 160 || !/[A-Za-z]/.test(w) || /^[\w.-]+$/.test(w) && !/^[A-Z]/.test(w)) continue;
    if (/^(true|false|nil|null|none|div|span|class|button|submit|text|hidden|post|get|delete|patch)$/i.test(w)) continue;
    if (/[<>{}$=;]|^\s*%|\bdef\b|\bconst\b/.test(w)) continue;
    if (/[(),]$|&\.|::|\.\w+\(|^@|\?\s*:|\|\|/.test(w)) continue;
    if (/^[,.;:]|&&|=>|\|\||^[A-Z][a-z]+(-[A-Z][a-z]+)+$|^(Arrow|Key)[A-Z]/.test(w)) continue;
    found.add(w);
  }
  const ids = new Set(); for (const m of line.matchAll(IDS)) ids.add(m[1]);
  return { words: [...found], ids: [...ids] };
}

export function screenFolders(gitFacts) {
  if (!gitFacts) return [];
  const files = gitFacts.ranked.filter((f) => SCREEN_KINDS.has(f.kind)).map((f) => f.path);
  const byFolder = new Map();
  for (const f of files) { const d = path.dirname(f); if (!byFolder.has(d)) byFolder.set(d, []); byFolder.get(d).push(path.basename(f)); }
  return [...byFolder.entries()].sort().map(([d, names]) => `- ${d}/: ${names.join(", ")}`);
}

export function screensFile(cwd, gitFacts) {
  if (!gitFacts) return null;
  const files = gitFacts.ranked.filter((f) => SCREEN_KINDS.has(f.kind)).map((f) => f.path);
  const parts = ["# Changed screen files and the words they add (read on this computer; nothing here is sent)", ""];
  const byFolder = new Map();
  for (const f of files) { const d = path.dirname(f); if (!byFolder.has(d)) byFolder.set(d, []); byFolder.get(d).push(path.basename(f)); }
  parts.push(`## Every changed screen file, by folder (${files.length})`);
  for (const [d, names] of [...byFolder.entries()].sort()) parts.push(`- ${d}/: ${names.join(", ")}`);
  parts.push("", "## Words each file adds on screen (from its added lines; labels, headings, messages, then ids)");
  const base = gitFacts.base?.sha;
  for (const f of files) {
    let added = [];
    const diff = base ? git(cwd, ["diff", "-U0", "--no-color", base, "--", f], { trim: false }) : null;
    if (diff) added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
    else { try { added = fs.readFileSync(path.join(cwd, f), "utf8").split("\n").slice(0, 400); } catch { added = []; } }
    const words = new Set(); const ids = new Set();
    for (const l of added) { const w = wordsIn(l); w.words.forEach((x) => words.add(x)); w.ids.forEach((x) => ids.add(x)); }
    if (!words.size && !ids.size) continue;
    const ws = [...words].slice(0, 60).map((w) => `"${cut(w, 100)}"`).join(", ");
    const is = [...ids].slice(0, 20).join(", ");
    parts.push(`- ${f}: ${ws}${is ? ` | ids: ${is}` : ""}`);
    if (parts.join("\n").length > MAX_FILE - 500) { parts.push("- (more files left out for length)"); break; }
  }
  // Rules and limits: added lines with a number and a limit word, from models, services, controllers and config.
  const RULE = /\b(limit|limits|max|maximum|min|minimum|at most|at least|per|within|every|days?|hours?|minutes?|seconds?|months?|weeks?|cap|rate|quota|throttle|expires?|retention|keep|kept)\b/i;
  const ruleLines = [];
  if (base) {
    const others = gitFacts.ranked.filter((f) => ["models", "controllers", "config", "code"].includes(f.kind)).map((f) => f.path).slice(0, 150);
    for (const f of others) {
      const diff = git(cwd, ["diff", "-U0", "--no-color", base, "--", f], { trim: false }) || "";
      for (const l of diff.split("\n")) {
        if (!l.startsWith("+") || l.startsWith("+++")) continue;
        const x = l.slice(1).trim();
        if (/\d/.test(x) && RULE.test(x) && x.length < 220 && !/^(#|\/\/)?\s*$/.test(x)) ruleLines.push(`- ${f}: ${x}`);
        if (ruleLines.length >= 90) break;
      }
      if (ruleLines.length >= 90) break;
    }
  }
  if (ruleLines.length) parts.splice(parts.indexOf("## Words each file adds on screen (from its added lines; labels, headings, messages, then ids)"), 0, "## Rules and limits in the changed code (added lines with a number: limits, time windows, how long things are kept)", ...ruleLines, "");
  return noSecrets(parts.join("\n")).slice(0, MAX_FILE);
}

const KEEP_MS = 24 * 60 * 60 * 1000;
const factsDir = () => path.join(configDir(), "facts");
const nameFor = (sessionId) => (/^[A-Za-z0-9_-]{1,100}$/.test(String(sessionId ?? "")) ? sessionId : "notes");
export const factsFilesFor = (sessionId) => ["session", "screens"].map((kind) => path.join(factsDir(), `${nameFor(sessionId)}-${kind}.md`));

// Deletes facts and notes files older than 24 hours. Never throws.
export function pruneSessionFiles(now = Date.now()) {
  for (const dir of [factsDir(), notesDir()]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(dir, name);
      try { if (now - fs.lstatSync(file).mtimeMs > KEEP_MS) fs.rmSync(file, { force: true }); } catch { /* gone already */ }
    }
  }
}

// After a send: this session's facts files and notes file are not needed any more. Never throws.
export function removeSessionFiles(sessionId) {
  for (const file of [...factsFilesFor(sessionId), notesFileFor(sessionId)]) {
    try { fs.rmSync(file, { force: true }); } catch { /* gone already */ }
  }
}

export function writeMoreFacts(sessionId, cwd, digest, gitFacts) {
  pruneSessionFiles();
  const name = nameFor(sessionId);
  const dir = factsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  const out = [];
  const write = (p, text) => { fs.writeFileSync(p, text, { mode: 0o600 }); fs.chmodSync(p, 0o600); out.push(p); };
  if (digest) write(path.join(dir, `${name}-session.md`), sessionFile(digest));
  const s = screensFile(cwd, gitFacts);
  if (s) write(path.join(dir, `${name}-screens.md`), s);
  return out;
}
