import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configDir, parseSiteUrl } from "./config.mjs";
import { CliError, EXIT } from "./output.mjs";

// Two private files live in the config directory:
//   credentials.json    { version, url, token, email, name, client_name, created_at }
//   pending-login.json  a device sign-in waiting for approval (login --start)
// Both are written atomically, created with mode 0600 inside a 0700 directory,
// read without following symlinks, and refused if another user owns them.

const CREDENTIALS = "credentials.json";
const PENDING = "pending-login.json";
const MAX_FILE_BYTES = 64 * 1024;
const TOKEN_FORMAT = /^cs_[A-Za-z0-9]{20,200}$/;

const ownUid = () => (typeof process.getuid === "function" ? process.getuid() : null);
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export const isWellFormedToken = (token) => typeof token === "string" && TOKEN_FORMAT.test(token);
const credentialsPath = () => path.join(configDir(), CREDENTIALS);

export function loadCredentials() {
  const data = readPrivateJson(CREDENTIALS);
  if (data === null) return null;

  const damaged = () =>
    new CliError(`The saved Cutscene sign-in at ${credentialsPath()} is damaged.`, {
      exitCode: EXIT.signedOut,
      hint: 'Run "cutscene login" to sign in again.',
    });
  if (data.version !== 1 || !isWellFormedToken(data.token) || typeof data.url !== "string") throw damaged();
  try {
    return { ...data, url: parseSiteUrl(data.url, "The saved site address") };
  } catch {
    throw damaged();
  }
}

export const saveCredentials = (credentials) => writePrivateJson(CREDENTIALS, { version: 1, ...credentials });
export const removeCredentials = () => removeFile(CREDENTIALS);

export function loadPendingLogin() {
  const data = readPrivateJson(PENDING);
  if (data === null) return null;
  const valid =
    typeof data.url === "string" &&
    typeof data.device_code === "string" &&
    typeof data.user_code === "string" &&
    Number.isInteger(data.interval) &&
    typeof data.expires_at === "string";
  if (!valid) {
    removeFile(PENDING);
    return null;
  }
  return { ...data, url: parseSiteUrl(data.url, "The pending sign-in address") };
}

export const savePendingLogin = (pending) => writePrivateJson(PENDING, pending);
export const removePendingLogin = () => removeFile(PENDING);

function readPrivateJson(name) {
  const file = path.join(configDir(), name);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") throw new CliError(`${file} is a symbolic link. Remove it and sign in again.`);
    throw new CliError(`Could not read ${file} (${error.code ?? error.message}).`);
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new CliError(`${file} is not a regular file. Remove it and sign in again.`);
    const uid = ownUid();
    if (uid !== null && stat.uid !== uid) throw new CliError(`${file} belongs to another user. Remove it and sign in again.`);
    if (stat.size > MAX_FILE_BYTES) throw new CliError(`${file} is too large to be a Cutscene file. Remove it and sign in again.`);
    // Someone loosened the permissions: tighten them before trusting the file.
    if (uid !== null && (stat.mode & 0o077) !== 0) fs.fchmodSync(fd, 0o600);

    const text = fs.readFileSync(fd, "utf8");
    try {
      const data = JSON.parse(text);
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  } finally {
    fs.closeSync(fd);
  }
}

function writePrivateJson(name, data) {
  const dir = ensurePrivateDir();
  const file = path.join(dir, name);
  const temporary = path.join(dir, `.${name}.${crypto.randomUUID()}.tmp`);

  // "wx" fails if the name exists, so nothing can be pre-planted at the
  // temporary path; rename then swaps the file in whole (it replaces a symlink
  // at the destination rather than writing through it).
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

// Called before a sign-in starts, so a config folder problem shows up before
// the user approves anything (not after, with the new token lost).
export function ensurePrivateDir() {
  const dir = configDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new CliError(`Could not create ${dir} (${error.code ?? error.message}). Set CUTSCENE_CONFIG_DIR to a folder you own.`);
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new CliError(`${dir} is not a directory. Remove it or set CUTSCENE_CONFIG_DIR.`);
  const uid = ownUid();
  if (uid !== null) {
    if (stat.uid !== uid) throw new CliError(`${dir} belongs to another user. Set CUTSCENE_CONFIG_DIR to a folder you own.`);
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  }
  return dir;
}

function removeFile(name) {
  fs.rmSync(path.join(configDir(), name), { force: true });
}
