import os from "node:os";
import { UnreachableError, apiError, apiRequest } from "../api.mjs";
import { openBrowser } from "../browser.mjs";
import { DEFAULT_URL, parseSiteUrl } from "../config.mjs";
import {
  ensurePrivateDir,
  isWellFormedToken,
  loadCredentials,
  loadPendingLogin,
  removePendingLogin,
  savePendingLogin,
  saveCredentials,
} from "../credentials.mjs";
import { CliError, EXIT, bold, clean, dim, note, printJson, say, usageError } from "../output.mjs";

export const spec = { help: "boolean", json: "boolean", start: "boolean", wait: "boolean", name: "string", "no-browser": "boolean" };

export const help = `Connect this computer to your Cutscene account (device sign-in).

Usage
  cutscene login              Show a code, open the browser, wait for approval
  cutscene login --start      Show the code and return at once (for agents)
  cutscene login --wait       Wait for the sign-in started with --start

Options
  --name <text>     How this computer is listed in Connected apps
                    (default "Claude Code on <computer name>")
  --no-browser      Do not open the browser; print the address only
  --json            Print the result as JSON

The token is saved to ~/.config/cutscene/credentials.json (mode 0600) and is
never printed. Signing in again replaces and revokes the previous token.`;

const MAX_INTERVAL_SECONDS = 60;
const SLOW_DOWN_STEP_SECONDS = 5;

export async function run(flags) {
  if (flags.start && flags.wait) throw usageError("Use --start or --wait, not both.");
  ensurePrivateDir();

  if (flags.wait) {
    const pending = loadPendingLogin();
    if (!pending || Date.parse(pending.expires_at) <= Date.now()) {
      removePendingLogin();
      throw new CliError("No sign-in is waiting for approval.", { hint: 'Run "cutscene login" to start one.' });
    }
    return waitForApproval(pending, flags);
  }

  const pending = await startDeviceSignIn(loginSite(), clientName(flags.name));
  if (flags.start) savePendingLogin(pending);
  const opened = !flags["no-browser"] && openBrowser(pending.verification_uri_complete);
  showCode(pending, opened, flags);

  if (flags.start) {
    if (!flags.json) note(`\nAfter approving, run ${bold("cutscene login --wait")} to finish.`);
    return EXIT.ok;
  }
  if (!flags.json) note(dim(`\nWaiting for approval. The code expires in ${minutesLeft(pending)}. Press Ctrl+C to cancel.`));
  return waitForApproval(pending, flags);
}

// Signing in picks the site from CUTSCENE_URL, then the site of the current
// sign-in, then the local default.
function loginSite() {
  if (process.env.CUTSCENE_URL) return parseSiteUrl(process.env.CUTSCENE_URL, "CUTSCENE_URL");
  return currentCredentials()?.url ?? DEFAULT_URL;
}

function clientName(custom) {
  if (custom !== undefined) {
    const name = clean(custom, 1000).trim();
    if (!name) throw usageError("--name cannot be empty.");
    if (name.length > 80) throw usageError("--name can be at most 80 characters.");
    return name;
  }
  const host = clean(os.hostname(), 200).replace(/\.local$/i, "").trim() || "this computer";
  return `Claude Code on ${host}`.slice(0, 80);
}

async function startDeviceSignIn(site, client_name) {
  const response = await apiRequest(site, "POST", "/device_authorizations", { body: { client_name } });
  if (response.status === 429) throw new CliError("Too many sign-in attempts from this computer. Wait a minute, then try again.");
  if (response.status !== 201) throw new CliError(`Could not start signing in: ${apiError(response).message}`);

  const data = response.data ?? {};
  const valid =
    typeof data.device_code === "string" &&
    data.device_code.length > 0 &&
    data.device_code.length <= 512 &&
    typeof data.user_code === "string" &&
    /^[A-Z0-9]{2,10}(?:-[A-Z0-9]{2,10})?$/.test(data.user_code) &&
    Number.isInteger(data.expires_in) &&
    data.expires_in > 0 &&
    Number.isInteger(data.interval) &&
    data.interval > 0;
  if (!valid) throw new CliError(`${site} answered the sign-in request in an unexpected format.`);

  // The browser only ever opens on the same site the code came from, so a
  // tampered answer cannot send the user to a look-alike approval page.
  const verificationUri = sameSiteUrl(data.verification_uri, site);
  const verificationUriComplete =
    data.verification_uri_complete === undefined ? verificationUri : sameSiteUrl(data.verification_uri_complete, site);
  if (!verificationUri || !verificationUriComplete) throw new CliError(`${site} sent an approval address on another site, so sign-in stopped.`);

  return {
    url: site,
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    interval: Math.min(data.interval, MAX_INTERVAL_SECONDS),
    expires_at: new Date(Date.now() + Math.min(data.expires_in, 3600) * 1000).toISOString(),
    client_name,
  };
}

function sameSiteUrl(raw, site) {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.origin === site && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function showCode(pending, opened, flags) {
  if (flags.json && flags.start) {
    printJson({
      user_code: pending.user_code,
      verification_uri: pending.verification_uri,
      verification_uri_complete: pending.verification_uri_complete,
      expires_at: pending.expires_at,
      browser_opened: opened,
    });
    return;
  }
  note("Confirm this code in your browser to connect Claude Code to Cutscene:\n");
  note(`    ${bold(pending.user_code)}\n`);
  note(`  ${pending.verification_uri_complete}`);
  note(opened ? dim("  (opened in your browser)") : dim("  Open this address in a browser where you are signed in to Cutscene."));
}

async function waitForApproval(pending, flags) {
  const deadline = Date.parse(pending.expires_at);
  let interval = pending.interval;
  let toldAboutConnection = false;

  const cancel = () => {
    note("\nSign-in cancelled. Nothing was connected.");
    process.exit(EXIT.cancelled);
  };
  process.once("SIGINT", cancel);

  try {
    while (Date.now() < deadline) {
      await sleep(interval * 1000);

      let response;
      try {
        response = await apiRequest(pending.url, "POST", "/device_authorizations/token", {
          body: { device_code: pending.device_code },
        });
      } catch (error) {
        if (!(error instanceof UnreachableError)) throw error;
        if (!toldAboutConnection) note(dim("Lost the connection to Cutscene. Still trying..."));
        toldAboutConnection = true;
        interval = Math.min(interval * 2, MAX_INTERVAL_SECONDS);
        continue;
      }

      if (response.status === 200) return finishSignIn(pending, response.data, flags);

      const { code, message } = apiError(response);
      if (code === "authorization_pending") continue;
      if (code === "slow_down" || response.status === 429) {
        interval = Math.min(Math.max(interval + SLOW_DOWN_STEP_SECONDS, response.retryAfter ?? 0), MAX_INTERVAL_SECONDS);
        continue;
      }
      if (response.status >= 500) {
        interval = Math.min(interval * 2, MAX_INTERVAL_SECONDS);
        continue;
      }

      removePendingLogin();
      if (code === "access_denied") throw new CliError("The sign-in was denied in the browser. Nothing was connected.");
      if (code === "expired_token") throw expiredError();
      throw new CliError(`Could not finish signing in: ${message}`);
    }
    removePendingLogin();
    throw expiredError();
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

async function finishSignIn(pending, data, flags) {
  if (!isWellFormedToken(data?.token)) {
    removePendingLogin();
    throw new CliError("Cutscene sent a sign-in token in an unexpected format, so it was not saved.");
  }
  const user = data.user && typeof data.user === "object" ? data.user : {};
  const previous = currentCredentials();

  saveCredentials({
    url: pending.url,
    token: data.token,
    email: typeof user.email === "string" ? clean(user.email, 320) : null,
    name: typeof user.name === "string" ? clean(user.name, 200) : null,
    client_name: pending.client_name,
    created_at: new Date().toISOString(),
  });
  removePendingLogin();

  // The replaced token would otherwise stay valid in Connected apps forever.
  if (previous && previous.token !== data.token) await revokeQuietly(previous);

  const email = typeof user.email === "string" ? clean(user.email, 320) : null;
  if (flags.json) {
    printJson({ signed_in: true, url: pending.url, email });
  } else {
    say(email ? `Signed in to Cutscene as ${email}.` : "Signed in to Cutscene.");
    note(dim(`This computer is listed as "${pending.client_name}" under Connected apps in Cutscene settings.`));
  }
  return EXIT.ok;
}

async function revokeQuietly(credentials) {
  try {
    await apiRequest(credentials.url, "DELETE", "/token", { token: credentials.token, timeoutMs: 5000 });
  } catch {
    // Best effort: the user can still revoke it from Connected apps.
  }
}

function currentCredentials() {
  try {
    return loadCredentials();
  } catch {
    return null;
  }
}

const expiredError = () => new CliError("The code expired before it was approved.", { hint: 'Run "cutscene login" to get a new one.' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function minutesLeft(pending) {
  const minutes = Math.max(1, Math.round((Date.parse(pending.expires_at) - Date.now()) / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
