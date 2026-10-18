import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, EXIT, clean, usageError } from "./output.mjs";

// The live service. For local development set CUTSCENE_URL=http://localhost:3700.
export const DEFAULT_URL = "https://trycutscene.com";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const manifestPath = fileURLToPath(new URL("../.claude-plugin/plugin.json", import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;

export function configDir() {
  const override = process.env.CUTSCENE_CONFIG_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".config", "cutscene");
}

const isLoopback = (url) => LOOPBACK_HOSTS.has(url.hostname);

// The site address must be a bare origin over HTTPS (plain HTTP only on this
// machine), so the token is never sent in clear text or to a path, query or
// embedded login that someone slipped into the address.
export function parseSiteUrl(raw, source) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw usageError(`${source} is not a valid address: "${clean(raw, 200)}".`, 'Use the site address, like "https://cutscene.example".');
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    throw usageError(
      `${source} must use https:// (got "${clean(url.origin, 200)}").`,
      "Plain http:// is allowed only for localhost and 127.0.0.1.",
    );
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw usageError(`${source} must be the site address only, with no path, query or login: "${clean(raw, 200)}".`);
  }
  return url.origin;
}

// Where an authenticated request goes. A stored token belongs to the site that
// issued it: if CUTSCENE_URL points somewhere else, refuse rather than hand the
// token to another server.
export function siteFor(credentials) {
  const fromEnv = process.env.CUTSCENE_URL;
  if (fromEnv) {
    const origin = parseSiteUrl(fromEnv, "CUTSCENE_URL");
    if (credentials && credentials.url !== origin) {
      throw new CliError(`You are signed in to ${credentials.url}, but CUTSCENE_URL is ${origin}.`, {
        exitCode: EXIT.signedOut,
        hint: `Run "cutscene login" to sign in to ${origin}, or unset CUTSCENE_URL.`,
      });
    }
    return origin;
  }
  return credentials ? credentials.url : DEFAULT_URL;
}
