import { execFileSync } from "node:child_process";
import path from "node:path";

const MAX_CHANGED_FILES = 200;
const MAX_PATH_LENGTH = 300;

// Facts about the current checkout for the context's metadata: repo name,
// branch, commit and the paths of changed files. Names only, never file
// contents or diffs. Returns {} outside a git repository.
export function collectGitMetadata(cwd = process.cwd()) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return {};

  const metadata = { repo: repoName(cwd, root) };
  const commit = git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const branch = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch) metadata.branch = branch;
  if (commit) metadata.commit = commit;

  const files = changedFiles(cwd, branch, commit);
  if (files.length > 0) metadata.changed_files = files;
  return metadata;
}

function git(cwd, args, { trim = true } = {}) {
  try {
    // No fsmonitor: a repo's config must not be able to run a program here.
    const output = execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    });
    return trim ? output.trim() : output;
  } catch {
    return null;
  }
}

// "host/owner/name" from the origin remote, with any embedded login or token
// stripped; the folder name when there is no usable remote.
function repoName(cwd, root) {
  const remote = git(cwd, ["config", "--get", "remote.origin.url"]);
  const fallback = path.basename(root);
  if (!remote) return fallback;

  const scpLike = remote.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  if (scpLike) return trimRepoPath(`${scpLike[1]}/${scpLike[2]}`) || fallback;

  try {
    const url = new URL(remote);
    if (url.protocol === "file:") return fallback;
    return trimRepoPath(`${url.hostname}${url.pathname}`) || fallback;
  } catch {
    return fallback;
  }
}

const trimRepoPath = (value) => value.replace(/\.git\/?$/, "").replace(/\/+$/, "").slice(0, MAX_PATH_LENGTH);

// What this branch changed: commits since it left the default branch, plus
// uncommitted work. On the default branch itself with a clean tree, the last
// commit's files stand in for "what was just done".
function changedFiles(cwd, branch, commit) {
  const files = new Set(uncommittedFiles(cwd));

  if (commit) {
    const base = branchBase(cwd, branch);
    const committed = base
      ? git(cwd, ["diff", "--name-only", "-z", base, commit])
      : files.size === 0
        ? git(cwd, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit])
        : null;
    for (const file of splitNul(committed)) files.add(file);
  }

  return [...files]
    .filter((file) => file.length <= MAX_PATH_LENGTH)
    .sort()
    .slice(0, MAX_CHANGED_FILES);
}

function branchBase(cwd, branch) {
  const candidates = [];
  const remoteHead = git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) candidates.push(remoteHead);
  candidates.push("main", "master", "origin/main", "origin/master");

  for (const candidate of candidates) {
    if (candidate === branch || candidate === `origin/${branch}`) continue;
    if (!git(cwd, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) continue;
    const base = git(cwd, ["merge-base", candidate, "HEAD"]);
    if (base) return base;
  }
  return null;
}

function uncommittedFiles(cwd) {
  // Untrimmed: the first entry's leading space is part of its status code.
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { trim: false });
  const entries = splitNul(status);
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    // Renames and copies carry the original path as the next entry.
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return files;
}

function splitNul(output) {
  if (!output) return [];
  return output.split("\0").filter(Boolean);
}
