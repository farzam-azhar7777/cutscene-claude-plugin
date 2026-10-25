import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./config.mjs";
import { readPrivateJson, readPrivateText, removeFile, writePrivateJson, writePrivateText } from "./credentials.mjs";
import { CliError } from "./output.mjs";

// Drafts: `send --dry-run` saves the exact payload it showed, and
// `send --draft <id>` sends those bytes, so what the person approved is what
// is sent (Claude never re-types 20 KB). Private files (0600 in a 0700
// folder), kept 24 hours, at most 20.
const DRAFTS = "drafts";
const MAX_DRAFTS = 20;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DRAFT_BYTES = 256 * 1024;
const DRAFT_ID = /^[A-Za-z0-9_-]{8}$/;

// last-sent.json: {version, sessions: {<session id>: {context_id, at, title}}}
// so "send the update" can point at the notes it replaces.
const LAST_SENT = "last-sent.json";
const MAX_SESSIONS = 50;

export function saveDraft(text) {
  pruneDrafts();
  const id = crypto.randomBytes(6).toString("base64url");
  writePrivateText(path.join(DRAFTS, `${id}.json`), text);
  pruneDrafts();
  return id;
}

export function loadDraft(id) {
  if (!DRAFT_ID.test(String(id))) throw new CliError(`"${String(id).slice(0, 40)}" is not a draft id.`, { hint: 'Use the id that "cutscene send --dry-run" printed.' });
  const name = path.join(DRAFTS, `${id}.json`);
  const file = path.join(configDir(), name);
  let stat = null;
  try {
    stat = fs.lstatSync(file);
  } catch {
    stat = null;
  }
  if (!stat || Date.now() - stat.mtimeMs > DRAFT_TTL_MS) {
    if (stat) removeFile(name);
    throw new CliError(`Draft ${id} is gone (drafts last 24 hours).`, { hint: 'Run "cutscene send --dry-run" again, then send the new draft.' });
  }
  const text = readPrivateText(name, MAX_DRAFT_BYTES);
  if (text === null) throw new CliError(`Draft ${id} is gone.`, { hint: 'Run "cutscene send --dry-run" again.' });
  return text;
}

export const removeDraft = (id) => (DRAFT_ID.test(String(id)) ? removeFile(path.join(DRAFTS, `${id}.json`)) : undefined);

function pruneDrafts() {
  const dir = path.join(configDir(), DRAFTS);
  let entries;
  try {
    entries = fs
      .readdirSync(dir)
      .filter((name) => /^[A-Za-z0-9_-]{8}\.json$/.test(name))
      .map((name) => ({ name, mtime: fs.lstatSync(path.join(dir, name)).mtimeMs }));
  } catch {
    return;
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  entries.forEach((entry, index) => {
    if (index >= MAX_DRAFTS || Date.now() - entry.mtime > DRAFT_TTL_MS) fs.rmSync(path.join(dir, entry.name), { force: true });
  });
}

export function lastSentFor(sessionId) {
  if (!sessionId) return null;
  try {
    const entry = readPrivateJson(LAST_SENT)?.sessions?.[sessionId];
    return entry && typeof entry.context_id === "string" ? entry : null;
  } catch {
    return null;
  }
}

export function recordSent(sessionId, contextId, title) {
  if (!sessionId || typeof contextId !== "string") return;
  try {
    const data = readPrivateJson(LAST_SENT) ?? {};
    const sessions = data.sessions && typeof data.sessions === "object" ? data.sessions : {};
    sessions[sessionId] = { context_id: contextId, at: new Date().toISOString(), title: typeof title === "string" ? title.slice(0, 200) : null };
    const newest = Object.entries(sessions)
      .sort((a, b) => String(b[1]?.at ?? "").localeCompare(String(a[1]?.at ?? "")))
      .slice(0, MAX_SESSIONS);
    writePrivateJson(LAST_SENT, { version: 1, sessions: Object.fromEntries(newest) });
  } catch {
    // Best effort: an update can still be sent as a new demo.
  }
}
