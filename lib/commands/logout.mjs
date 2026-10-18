import { UnreachableError, apiError, apiRequest } from "../api.mjs";
import { loadCredentials, removeCredentials, removePendingLogin } from "../credentials.mjs";
import { CliError, EXIT, clean, printJson, say } from "../output.mjs";

export const spec = { help: "boolean", json: "boolean" };

export const help = `Sign this computer out of Cutscene: revokes its token and deletes
~/.config/cutscene/credentials.json.

Usage
  cutscene logout [--json]`;

export async function run(flags) {
  removePendingLogin();

  let credentials;
  try {
    credentials = loadCredentials();
  } catch {
    removeCredentials();
    return done(flags, { signed_out: true, revoked: false }, "Removed a damaged sign-in file. This computer is signed out.");
  }
  if (!credentials) return done(flags, { signed_out: true, revoked: false }, "Not signed in. Nothing to do.");

  // Revoke at the site that issued the token, whatever CUTSCENE_URL says now.
  let problem = null;
  try {
    const response = await apiRequest(credentials.url, "DELETE", "/token", { token: credentials.token });
    // 401: the token was already revoked or expired, which is the goal.
    if (!(response.status === 204 || response.status === 200 || response.status === 401)) problem = apiError(response).message;
  } catch (error) {
    if (!(error instanceof UnreachableError)) throw error;
    problem = error.message;
  }

  // The local copy goes either way: the user asked to sign out here.
  removeCredentials();

  if (problem) {
    const client = credentials.client_name ? `"${clean(credentials.client_name, 80)}"` : "this computer";
    throw new CliError(`Signed out on this computer, but the token could not be revoked: ${problem}`, {
      hint: `Revoke ${client} under Connected apps in Cutscene settings.`,
    });
  }
  return done(flags, { signed_out: true, revoked: true }, "Signed out of Cutscene. This computer's token is revoked.");
}

function done(flags, result, message) {
  if (flags.json) printJson(result);
  else say(message);
  return EXIT.ok;
}
