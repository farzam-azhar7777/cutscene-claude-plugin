import { usageError } from "./output.mjs";

// A small strict parser: unknown flags are errors, so a typo never silently
// changes what gets sent. `spec` maps a flag name to "string", "boolean" or
// "list" (repeatable string).
export function parseArgs(argv, spec, command) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    const type = spec[name];
    if (!type) throw usageError(`Unknown option --${name} for "cutscene ${command}".`, `Run "cutscene ${command} --help".`);

    if (type === "boolean") {
      if (equals !== -1) throw usageError(`--${name} does not take a value.`);
      flags[name] = true;
      continue;
    }

    let value;
    if (equals !== -1) {
      value = arg.slice(equals + 1);
    } else {
      value = argv[index + 1];
      // A known flag in value position means the value was forgotten.
      if (value === undefined || isKnownFlag(value, spec)) throw usageError(`--${name} needs a value.`);
      index += 1;
    }

    if (type === "list") (flags[name] ??= []).push(value);
    else flags[name] = value;
  }

  return { flags, positional };
}

function isKnownFlag(value, spec) {
  if (value === "-h") return true;
  if (!value.startsWith("--")) return false;
  const name = value.slice(2).split("=")[0];
  return name === "help" || Boolean(spec[name]);
}
