import { CLASSES, MAX_URLS, checkUrls, summarizePages } from "../urlcheck.mjs";
import { EXIT, clean, printJson, say, usageError } from "../output.mjs";

export const spec = { help: "boolean", json: "boolean", url: "list", wait: "string" };
export const positional = true;

export const help = `Check that the demo's pages answer on this computer, before sending.

Usage
  cutscene check-urls <url> [<url> ...]
  cutscene check-urls --wait 60 http://localhost:3000/billing

Each address is classed as: loads, needs sign-in, redirects, not found,
server error, nothing running, no answer or blocked host. Only addresses on
this computer (localhost, *.localhost, 127.0.0.1, [::1]) are opened; others
are listed as not checked. No cookies or Cutscene token are sent, so pages
behind a sign-in show as "needs sign-in". Addresses that could sign out or
change data (logout, delete, pay, ...) are not opened.

Options
  --url <url>        Another address (same as a plain argument)
  --wait <seconds>   First wait up to this long for the server to start (max 120)
  --json             Print the results as JSON

At most ${MAX_URLS} addresses. Exits 0 whenever the check ran, 2 for wrong usage.`;

export async function run(flags, positionalArgs = []) {
  const urls = [...positionalArgs, ...(flags.url ?? [])];
  if (urls.length === 0) throw usageError("Give at least one address to check.", 'Like "cutscene check-urls http://localhost:3000/billing".');

  let waitSeconds = 0;
  if (flags.wait !== undefined) {
    waitSeconds = Number(flags.wait);
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 120) throw usageError("--wait takes a whole number of seconds from 0 to 120.");
  }

  const { results, dropped } = await checkUrls(urls, { waitSeconds });
  if (flags.json) {
    printJson({
      pages: results.map((result) => ({ url: result.url, class: CLASSES[result.class] ?? CLASSES.not_checked, label: result.label, status: result.status ?? null, location: result.location ?? null, ms: result.ms ?? null })),
      summary: summarizePages(results),
      not_checked_over_limit: dropped,
    });
    return EXIT.ok;
  }

  for (const result of results) say(`${clean(result.url, 300)}: ${result.label}`);
  if (dropped) say(`${dropped} more addresses were not checked (at most ${MAX_URLS}).`);
  say(summarizePages(results));
  return EXIT.ok;
}
