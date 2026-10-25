import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_CHANGED_FILES = 200;
const MAX_PATH_LENGTH = 300;
const MAX_COMMITS = 15;

// Facts about the current checkout for the context's metadata: repo name,
// branch, commit and the paths of changed files, most useful for a demo first
// (routes and views before images and lockfiles). Names only, never file
// contents or diffs. Returns {} outside a git repository.
export function collectGitMetadata(cwd = process.cwd()) {
  const facts = gitFacts(cwd);
  if (!facts) return {};

  const metadata = { repo: facts.repo };
  if (facts.branch) metadata.branch = facts.branch;
  if (facts.commit) metadata.commit = facts.commit;
  const files = facts.ranked.slice(0, MAX_CHANGED_FILES).map((file) => file.path);
  if (files.length > 0) metadata.changed_files = files;
  const skipped = Object.values(facts.skipped).reduce((sum, count) => sum + count, 0);
  if (skipped > 0) metadata.changed_files_skipped = facts.skipped;
  if (facts.total > files.length) metadata.changed_files_total = facts.total;
  return metadata;
}

// Everything the session facts and the metadata need, from read-only git
// commands: { root, repo, branch, commit, base: {ref, sha}|null, commits,
// ranked: [{path, kind, churn}], skipped: {kind: count}, total, uncommitted }.
export function gitFacts(cwd = process.cwd()) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;

  const commit = git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const branch = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const uncommitted = uncommittedFiles(cwd);
  const base = commit ? branchBase(cwd, branch) : null;

  const files = new Set(uncommitted.map((entry) => entry.path));
  let churn = new Map();
  if (commit) {
    if (base) {
      for (const file of splitNul(git(cwd, ["diff", "--name-only", "-z", base.sha, commit]))) files.add(file);
      churn = numstat(git(cwd, ["diff", "--numstat", "-z", base.sha]));
    } else if (files.size === 0) {
      // On the default branch with a clean tree, the last commit stands in for "what was just done".
      for (const file of splitNul(git(cwd, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", commit]))) files.add(file);
      churn = numstat(git(cwd, ["diff-tree", "--root", "--no-commit-id", "--numstat", "-r", "-z", commit]));
    } else {
      churn = numstat(git(cwd, ["diff", "--numstat", "-z", "HEAD"]));
    }
  }
  // New files are not in a diff yet: a rough line count from their size.
  for (const entry of uncommitted) {
    if (entry.untracked && !churn.has(entry.path)) churn.set(entry.path, approximateLines(path.join(root, entry.path)));
  }

  const all = [...files].filter((file) => file.length <= MAX_PATH_LENGTH);
  const { ranked, skipped } = rankChangedFiles(all, churn);
  return {
    root,
    repo: repoName(cwd, root),
    branch,
    commit,
    base,
    commits: base ? commitsSince(cwd, base.sha) : [],
    ranked,
    skipped,
    total: all.length,
    uncommitted: uncommitted.length,
  };
}

// What a demo writer reads first. Lower rank = more useful: the pages a viewer
// sees and the words on them, then the code behind them.
const KINDS = [
  ["routes", "route"],
  ["views", "view"],
  ["locales", "locale"],
  ["controllers", "controller"],
  ["e2e", "system test"],
  ["js", "script or style"],
  ["models", "model or service"],
  ["tests", "test"],
  ["code", "code"],
  ["migrations", "migration or seed"],
  ["config", "config"],
  ["docs", "docs"],
];
export const KIND_LABELS = Object.fromEntries(KINDS);
const RANK = Object.fromEntries(KINDS.map(([kind], index) => [kind, index]));

const SKIP_RULES = [
  ["images", /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|ico|icns|svg|heic|psd|ai|sketch|fig|xcf)$/i],
  ["media", /\.(mp4|m4v|mov|webm|mkv|avi|mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i],
  ["fonts", /\.(woff2?|ttf|otf|eot)$/i],
  [
    "lockfiles",
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|go\.sum|mix\.lock|pubspec\.lock|uv\.lock|Podfile\.lock)$/,
  ],
  ["vendor", /(^|\/)(vendor|node_modules|bower_components|third_party|Pods)\//],
  [
    "build output",
    /(^|\/)(dist|build|out|\.next|\.nuxt|\.svelte-kit|\.output|\.turbo|\.vercel|coverage|tmp|log|logs|storage|public\/assets|public\/packs|public\/build|app\/assets\/builds)\/|\.(min\.js|min\.css|map)$/,
  ],
  ["system files", /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\.localized)$/],
  ["binary files", /\.(zip|tar|gz|tgz|bz2|xz|rar|7z|pdf|exe|dll|so|dylib|dmg|bin|wasm|db|sqlite3?|jar|class|pyc)$/i],
];

const RULES = [
  ["e2e", /(^|\/)(test\/system|spec\/system|spec\/features|spec\/requests|test\/integration|e2e|tests?\/e2e|cypress|playwright)\//],
  [
    "tests",
    /(^|\/)(test|tests|spec|specs|__tests__|__mocks__)\/|\.(test|spec)\.[cm]?[jt]sx?$|_(test|spec)\.(rb|go|py|exs?)$|(^|\/)test_[^/]*\.py$/,
  ],
  ["migrations", /(^|\/)(db\/migrate|db\/migrations|migrations|prisma)\/|(^|\/)db\/(schema\.rb|structure\.sql|seeds\.rb|seeds\/)|\.sql$/],
  ["locales", /(^|\/)(config\/locales|locales|locale|i18n|lang|translations)\/|\.(po|pot|xliff|arb)$/],
  [
    "routes",
    /(^|\/)config\/routes(\.rb$|\/)|(^|\/)(app|src\/app)\/(.+\/)?(page|layout|route|loading|error|not-found|template)\.[cm]?[jt]sx?$|(^|\/)(pages|routes|src\/routes|app\/routes)\/|(^|\/)(router|routes)\.[cm]?[jt]sx?$|\.routes\.[cm]?[jt]s$|(^|\/)urls\.py$/,
  ],
  [
    "views",
    /\.(erb|haml|slim|ejs|hbs|handlebars|mustache|njk|liquid|twig|jinja2?|j2|pug|vue|svelte|astro|tsx|jsx|html?|blade\.php|cshtml|razor|heex|leex)$|(^|\/)(app\/views|views|templates|app\/components|components)\//i,
  ],
  ["js", /(^|\/)app\/javascript\/|(^|\/)(app\/assets\/stylesheets|styles)\/|\.(css|scss|sass|less|styl|pcss)$/],
  ["controllers", /(^|\/)(app\/controllers|controllers|handlers|app\/api|resolvers|endpoints|server\/api)\/|_controller\.rb$|(^|\/)views\.py$/],
  [
    "models",
    /(^|\/)(app\/models|models|app\/services|services|app\/jobs|jobs|app\/helpers|helpers|app\/mailers|mailers|policies|serializers|queries|forms|lib|app\/lib|src\/lib|utils|hooks|store|stores|state)\//,
  ],
  [
    "config",
    /(^|\/)(config|\.github|\.circleci|\.claude|\.vscode|\.idea|deploy|docker|k8s|helm|terraform|infra|\.devcontainer)\/|(^|\/)(Dockerfile|Procfile[^/]*|Makefile|Rakefile|Gemfile|package\.json|tsconfig[^/]*\.json|\.tool-versions|\.nvmrc|\.ruby-version|\.gitignore|\.env\.example)$|\.config\.[cm]?[jt]s$|\.(ya?ml|toml|ini|conf|cfg)$/,
  ],
  ["docs", /\.(md|mdx|rst|adoc|txt)$|(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|CHANGELOG|AUTHORS)[^/]*$/i],
  ["js", /\.[cm]?[jt]s$|\.coffee$/],
  ["code", /\.(rb|py|go|rs|java|kt|kts|php|exs?|cs|swift|scala|clj|dart|lua|pl|sh)$/],
];

export function classifyPath(file) {
  for (const [kind, pattern] of SKIP_RULES) if (pattern.test(file)) return { skip: kind };
  for (const [kind, pattern] of RULES) if (pattern.test(file)) return { kind };
  return { kind: "code" };
}

// Ranks paths by kind, then by lines changed, then by name. Media, fonts,
// lockfiles, vendored and generated files are only counted.
export function rankChangedFiles(files, churn = new Map()) {
  const skipped = {};
  const kept = [];
  for (const file of files) {
    const result = classifyPath(file);
    if (result.skip) skipped[result.skip] = (skipped[result.skip] ?? 0) + 1;
    else kept.push({ path: file, kind: result.kind, churn: churn.get(file) ?? 0 });
  }
  kept.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.churn - a.churn || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ranked: kept, skipped };
}

export function git(cwd, args, { trim = true } = {}) {
  try {
    // No fsmonitor: a repo's config must not be able to run a program here.
    const output = execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
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

function branchBase(cwd, branch) {
  const candidates = [];
  const remoteHead = git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) candidates.push(remoteHead);
  candidates.push("main", "master", "origin/main", "origin/master");

  for (const candidate of candidates) {
    if (candidate === branch || candidate === `origin/${branch}`) continue;
    if (!git(cwd, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) continue;
    const sha = git(cwd, ["merge-base", candidate, "HEAD"]);
    if (sha) return { ref: candidate, sha };
  }
  return null;
}

function commitsSince(cwd, base) {
  const log = git(cwd, ["log", "-z", `--max-count=${MAX_COMMITS}`, "--format=%h %s", `${base}..HEAD`]);
  return splitNul(log).map((line) => {
    const space = line.indexOf(" ");
    return { sha: line.slice(0, space), subject: line.slice(space + 1).slice(0, 200) };
  });
}

function uncommittedFiles(cwd) {
  // Untrimmed: the first entry's leading space is part of its status code.
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { trim: false });
  const entries = splitNul(status);
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    files.push({ path: entry.slice(3), untracked: entry.startsWith("??") });
    // Renames and copies carry the original path as the next entry.
    if (entry[0] === "R" || entry[0] === "C") index += 1;
  }
  return files;
}

// `--numstat -z`: "added<TAB>deleted<TAB>path<NUL>"; renames put the paths in
// the next two NUL entries. Binary files show "-" and count as 0.
function numstat(output) {
  const churn = new Map();
  const entries = splitNul(output);
  for (let index = 0; index < entries.length; index += 1) {
    const match = entries[index].match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!match) continue;
    let file = match[3];
    if (file === "") {
      file = entries[index + 2] ?? "";
      index += 2;
    }
    const lines = (Number(match[1]) || 0) + (Number(match[2]) || 0);
    if (file) churn.set(file, lines);
  }
  return churn;
}

function approximateLines(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? Math.min(Math.round(stat.size / 30), 5000) : 0;
  } catch {
    return 0;
  }
}

function splitNul(output) {
  if (!output) return [];
  return output.split("\0").filter(Boolean);
}
