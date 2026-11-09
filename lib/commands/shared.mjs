import { loadCredentials } from "../credentials.mjs";
import { CliError, EXIT } from "../output.mjs";

export function requireCredentials() {
  const credentials = loadCredentials();
  if (!credentials) {
    throw new CliError("Not signed in to Cutscene.", { exitCode: EXIT.signedOut, hint: 'Run "cutscene login" to connect this computer.' });
  }
  return credentials;
}
