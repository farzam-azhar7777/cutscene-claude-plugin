import { spawn } from "node:child_process";

// Opens an http(s) address in the default browser. Returns false when there
// is no local browser to open (SSH session, no display, opted out). The URL
// is passed as one argument to a fixed program, never through a shell.
export function openBrowser(url) {
  if (!/^https?:\/\//.test(url)) return false;
  if (process.env.CUTSCENE_NO_BROWSER || process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;

  let command;
  let args;
  switch (process.platform) {
    case "darwin":
      command = "open";
      args = [url];
      break;
    case "win32":
      // rundll32 takes the URL verbatim; "cmd /c start" would re-parse it.
      command = "rundll32";
      args = ["url.dll,FileProtocolHandler", url];
      break;
    default:
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
      command = "xdg-open";
      args = [url];
  }

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
