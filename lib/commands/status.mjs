import { apiError, apiRequest, signedOutError } from "../api.mjs";
import { siteFor } from "../config.mjs";
import { CliError, EXIT, clean, printJson, say } from "../output.mjs";
import { requireCredentials } from "./shared.mjs";

export const spec = { help: "boolean", json: "boolean" };

export const help = `Show which Cutscene account this computer is signed in to.

Usage
  cutscene status [--json]

Exits with 3 when not signed in or the sign-in is no longer valid.`;

export async function run(flags) {
  const credentials = requireCredentials();
  const site = siteFor(credentials);
  const response = await apiRequest(site, "GET", "/me", { token: credentials.token });

  if (response.status === 401) throw signedOutError();
  if (response.status !== 200) throw new CliError(`Could not check the sign-in: ${apiError(response).message}`);

  const me = response.data ?? {};
  if (typeof me.email !== "string") throw new CliError(`${site} answered in an unexpected format.`);

  if (flags.json) {
    printJson({ signed_in: true, url: site, user: me });
    return EXIT.ok;
  }

  const name = typeof me.name === "string" && me.name.trim() ? ` (${clean(me.name, 200)})` : "";
  say(`Signed in to Cutscene as ${clean(me.email, 320)}${name}.`);
  say(`Site: ${site}`);
  const plan = describePlan(me);
  if (plan) say(`Plan: ${plan}`);
  return EXIT.ok;
}

function describePlan(me) {
  const planName = me.plan === "pro" ? "Pro" : me.plan === "free" ? "Free" : null;
  if (!planName) return null;
  const used = me.usage?.seconds_used;
  const included = me.usage?.seconds_included;
  if (!Number.isInteger(used) || !Number.isInteger(included)) return planName;
  return `${planName}, ${clock(used)} of ${clock(included)} used this month`;
}

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
