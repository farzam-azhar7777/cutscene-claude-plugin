// Terminal output. Everything a server or a file supplies goes through
// `clean` first, so a hostile response cannot inject terminal escape
// sequences (cursor moves, fake prompts, hyperlinks) into the user's shell.

export const EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  usage: 2,
  signedOut: 3,
  unreachable: 4,
  cancelled: 130,
});

export class CliError extends Error {
  constructor(message, { exitCode = EXIT.failed, hint } = {}) {
    super(message);
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export const usageError = (message, hint) => new CliError(message, { exitCode: EXIT.usage, hint });

// C0/C1 control characters except tab and newline, plus DEL.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function clean(value, maxLength = 500) {
  const text = String(value ?? "").replace(CONTROL, "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

const useColor = (stream) => stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

export const bold = (text, stream = process.stderr) => (useColor(stream) ? `\u001b[1m${text}\u001b[22m` : text);
export const dim = (text, stream = process.stderr) => (useColor(stream) ? `\u001b[2m${text}\u001b[22m` : text);

export const say = (text = "") => process.stdout.write(`${text}\n`);
export const note = (text = "") => process.stderr.write(`${text}\n`);
export const printJson = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

export function reportError(error) {
  note(`cutscene: ${clean(error.message, 2000)}`);
  if (error.hint) note(clean(error.hint, 2000));
}
