import { parseArgs } from "./args.mjs";
import * as login from "./commands/login.mjs";
import * as logout from "./commands/logout.mjs";
import * as send from "./commands/send.mjs";
import * as status from "./commands/status.mjs";
import { VERSION } from "./config.mjs";
import { CliError, EXIT, reportError, say, usageError } from "./output.mjs";

const COMMANDS = { login, send, status, logout };

const HELP = `cutscene ${VERSION}: send demo context from your coding agent to Cutscene.

Usage
  cutscene login     Connect this computer to your Cutscene account
  cutscene send      Send demo context (markdown or JSON on stdin)
  cutscene status    Show which account is signed in
  cutscene logout    Sign out and revoke this computer's token

  cutscene <command> --help    Options for one command
  cutscene --version           Print the version

Environment
  CUTSCENE_URL          Cutscene site address (default https://trycutscene.com).
                        Must be https://, except for localhost and 127.0.0.1.
  CUTSCENE_CONFIG_DIR   Folder for credentials.json (default ~/.config/cutscene)
  CUTSCENE_NO_BROWSER   Set to 1 to never open a browser

Exit codes
  0 done, 1 failed, 2 wrong usage, 3 not signed in, 4 Cutscene unreachable,
  130 cancelled`;

export async function main(argv) {
  const [command, ...rest] = argv;

  try {
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      const topic = COMMANDS[rest[0]];
      say(topic ? topic.help : HELP);
      return EXIT.ok;
    }
    if (command === "--version" || command === "-v" || command === "version") {
      say(VERSION);
      return EXIT.ok;
    }

    const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
    if (!handler) throw usageError(`Unknown command "${command}".`, 'Run "cutscene --help" to see the commands.');

    const { flags, positional } = parseArgs(rest, handler.spec, command);
    if (flags.help) {
      say(handler.help);
      return EXIT.ok;
    }
    if (positional.length > 0) throw usageError(`Unexpected argument "${positional[0]}".`, `Run "cutscene ${command} --help".`);

    return await handler.run(flags);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    reportError(error);
    return error.exitCode;
  }
}
