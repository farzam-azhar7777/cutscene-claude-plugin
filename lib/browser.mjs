import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Opens an http(s) address in Google Chrome, where the Cutscene extension
// and the user's Cutscene sign-in live; falls back to the default browser.
// Programs get the URL as one argument, never through a shell.
//
// Returns { opened, how } where how is "chrome", "browser" (CUTSCENE_BROWSER),
// "default", "hook" (CUTSCENE_OPEN_COMMAND) or a reason it was not opened.
//
// CUTSCENE_BROWSER: open in another browser instead (macOS: an app name like
//   "Brave Browser" or a bundle id like com.brave.Browser; elsewhere a path).
// CUTSCENE_OPEN_COMMAND: a program that receives the URL (tests use it).
// CUTSCENE_NO_BROWSER, SSH sessions and Linux without a display: not opened.

const WAIT_MS = 3000;
const CHROME_BUNDLE_ID = "com.google.Chrome";

export async function openInChrome(url, { env = process.env, platform = process.platform, run = runProgram } = {}) {
  if (!/^https?:\/\//.test(url)) return { opened: false, how: "not a web address" };
  if (env.CUTSCENE_OPEN_COMMAND) {
    return { opened: await run(env.CUTSCENE_OPEN_COMMAND, [url]), how: "hook" };
  }
  if (env.CUTSCENE_NO_BROWSER) return { opened: false, how: "CUTSCENE_NO_BROWSER is set" };
  if (env.SSH_CONNECTION || env.SSH_TTY) return { opened: false, how: "SSH session" };

  for (const [program, args, how] of plans(url, { env, platform })) {
    if (await run(program, args)) return { opened: true, how };
  }
  return { opened: false, how: "no browser could be opened" };
}

// Each plan is [program, args, how], tried in order until one exits 0.
export function plans(url, { env = process.env, platform = process.platform } = {}) {
  const custom = env.CUTSCENE_BROWSER?.trim();
  const list = [];
  if (platform === "darwin") {
    if (custom) {
      const isBundleId = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(custom) && !custom.endsWith(".app");
      list.push(["open", isBundleId ? ["-b", custom, url] : ["-a", custom, url], "browser"]);
    }
    list.push(["open", ["-b", CHROME_BUNDLE_ID, url], "chrome"]);
    list.push(["open", [url], "default"]);
    return list;
  }
  if (platform === "win32") {
    if (custom) list.push([custom, [url], "browser"]);
    const chrome = windowsChrome(env);
    if (chrome) list.push([chrome, [url], "chrome"]);
    // rundll32 takes the URL verbatim; "cmd /c start" would re-parse it.
    list.push(["rundll32", ["url.dll,FileProtocolHandler", url], "default"]);
    return list;
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return [];
  if (custom) list.push([custom, [url], "browser"]);
  for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    const found = onPath(name, env);
    if (found) {
      list.push([found, [url], "chrome"]);
      break;
    }
  }
  list.push(["xdg-open", [url], "default"]);
  return list;
}

// Chrome's own launcher on Windows: the App Paths registry entry, then the
// usual install folders.
function windowsChrome(env) {
  for (const hive of ["HKLM", "HKCU"]) {
    try {
      const out = execFileSync("reg", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, "/ve"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const match = out.match(/REG_(?:EXPAND_)?SZ\s+(.+\.exe)/i);
      if (match && fs.existsSync(match[1].trim())) return match[1].trim();
    } catch {
      // Not registered in this hive.
    }
  }
  const folders = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean);
  for (const folder of folders) {
    const candidate = path.join(folder, "Google", "Chrome", "Application", "chrome.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function onPath(name, env) {
  for (const dir of String(env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

// Runs a program and waits up to 3 seconds for it to exit. `open` and the
// Windows launcher exit quickly; a browser binary started directly keeps
// running, so "still running after 3 s" also counts as opened.
function runProgram(program, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(program, args, { stdio: "ignore", detached: true, windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.unref();
      resolve(true);
    }, WAIT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
