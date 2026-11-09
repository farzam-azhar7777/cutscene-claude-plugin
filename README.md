# Cutscene for Claude Code

Ask Claude Code for a demo of what it just built. Claude writes complete demo
notes from the session and the code (every part it built, chapter by chapter,
with the exact buttons and pages), checks that the pages load, and shows you a
short summary. Once you choose Send, the notes open in the Cutscene panel in
Chrome: press Write script and Cutscene writes a narrated script, records the
demo in your own signed-in browser, and gives you one video with a chapter for
each part, its share link already copied.

Cutscene is free for 10 minutes of AI demos a month (reset on the 1st), and
recording yourself uses no minutes. Paid plans, and how long each plan keeps
videos, are on [trycutscene.com](https://trycutscene.com/#pricing).

## What you need

- Claude Code, and Node 18 or newer on your `PATH`
- Google Chrome with the [Cutscene extension](https://chromewebstore.google.com/detail/cutscene/bheofgkkeaedknlnkaejmlgdimmphcbd)
- A Cutscene account. You can create one during the first sign-in.

The plugin works in Claude Code (terminal, IDE extensions and the desktop
app's Code tab). It does not run in claude.ai chat or Cowork, because it ships
a small command-line tool.

## Install

```
claude plugin marketplace add farzam-azhar7777/cutscene-claude-plugin
claude plugin install cutscene@cutscene
```

Or, inside a Claude Code session:

```
/plugin marketplace add farzam-azhar7777/cutscene-claude-plugin
/plugin install cutscene@cutscene
```

Then run `/reload-plugins`, or start a new session.

## Update

Plugins from this marketplace do not update by themselves. To get the newest
version:

```
claude plugin marketplace update cutscene
claude plugin update cutscene@cutscene
```

Then run `/reload-plugins`, or start a new session.

Coming from 0.4.0: after the update, the first send asks you to sign in once
with a code (below). The 0.4 connection stays under Connected apps in
Cutscene settings until you press Disconnect.

## Use

After Claude has built something in a session, run:

```
/cutscene:demo
```

or just ask: "make a demo video of this". You can name what to show:
`/cutscene:demo the new invoice export`.

1. Claude reads this session (what you asked, what it built, the files it
   changed), the code behind the pages and your git branch, all on your
   computer. It writes the demo notes: one chapter per part of the work, each
   with its start page and steps like "Click "Mark as paid" (button). Expect
   a dialog ...". There is no word limit; the notes can be up to 20 KB.
2. It checks that the pages answer on your computer (loads, needs sign-in,
   not found) and fixes addresses that are wrong.
3. It asks you something only when it cannot tell from the session or the
   code, for example which address to record on when you ask for production.
4. You see a summary (title, who it is for, where it starts, the chapters,
   and what else goes with them). Choose Send, Show full text (every line
   and detail) or Change something. Nothing goes out until you choose Send.
5. Chrome opens and the notes show in the Cutscene panel. If the panel is
   already open on your app, it takes the notes and goes to the start page by
   itself; otherwise press the Cutscene icon (or Control+Shift+C on a Mac,
   Alt+Shift+C elsewhere). Press Write script: the script is written, voiced
   and recorded without more clicks.

The first time, Claude signs you in: a code appears in the terminal and
Chrome opens Cutscene's approval page. Check that the codes match and choose
Yes, connect. No password or token is typed into the terminal.

Change something after sending, and Claude asks whether to send the
updated demo; the panel shows the new version in place of the old one, and
recording it keeps the link you already shared. The
first time Claude starts the demo skill by itself, Claude Code asks once
whether it may use it.

A demo can continue in another tab you have open (say, a payment provider's
test dashboard), wait until a result shows up, and hand you the steps only a
person can do, like attaching a file.

## What is sent, and where

The plugin talks to one site: `https://trycutscene.com`, under `/api/v1`.

| When | Request | What it carries |
| --- | --- | --- |
| Sign-in | `POST /device_authorizations`, then `POST /device_authorizations/token` | A device name for your Connected apps list ("Claude Code on" plus your computer's name; change it with `cutscene login --name`) |
| Status | `GET /me` | Your token, to show which account is signed in |
| Send | `POST /contexts` | The demo notes below |
| After sending | `GET /contexts/<id>`, up to 6 times in 6 seconds | Asks whether the Cutscene panel has the notes, to tell you what to press |
| Sign-out | `DELETE /token` | Revokes this computer's token |

The demo notes are:

- What a viewer needs: a title, a short description, who the video is for,
  where to start, and the chapters with their steps. At most 20 KB.
- Metadata: repository name (host/owner/name, with any login stripped),
  branch, commit, the paths of changed files (most useful first; images,
  fonts, lockfiles and build output only counted), the app URL, the result
  for each page the check got an answer from (loads, needs sign-in, not
  found, ...), the plugin version, and this Claude Code session's id (so an
  update replaces the notes it sent before).

Not sent: Claude is told never to include source code, diffs, file contents,
environment values, test logins or customer data. Before you choose Send
you see a summary, and Show full text shows every line and every detail
that goes with it. The session transcript is read on your computer to write
the notes and is never sent. The metadata never holds file contents or
diffs. If the text looks like it contains a password, key or token, the tool
refuses to send it.

How Cutscene stores and deletes this data: [privacy policy](https://trycutscene.com/privacy).
Terms: [trycutscene.com/terms](https://trycutscene.com/terms).

## What runs on your computer

- `bin/cutscene`, a Node script with no dependencies and no build step. The
  source in `lib/` is the code that runs. It finds Node 18 or newer on your
  `PATH` or from asdf, nvm, volta, fnm, mise or Homebrew.
- `bin/cutscene-facts`, run when you ask for a demo: it reads this session's
  transcript in `~/.claude/projects` (what you typed, what Claude said it
  did, the files it changed and the commands it ran, never their output or
  file contents), plus git and your dev-server settings, and gives Claude a
  summary of at most 24,000 characters. It also keeps a short summary of the
  session on your computer for up to 24 hours, to write the notes: two files
  in `~/.config/cutscene/facts` (the session's newest summary, Claude's
  reports, your requests and the documents Claude wrote; the changed screen
  files and the words each one adds on screen), in a folder only you can
  read. They are deleted after the send, and any older than 24 hours on the
  next run. Lines that look like a password, key or token are left out.
  Nothing from it is sent anywhere.
- Read-only git commands (`rev-parse`, `symbolic-ref`, `config --get
  remote.origin.url`, `merge-base`, `diff --name-only`, `diff --numstat`,
  `diff-tree`, `log`, `status --porcelain`) for the facts and the metadata.
- Page checks (`cutscene check-urls`): plain GET requests to addresses on
  this computer only (localhost, *.localhost, 127.0.0.1, [::1]), at most 25
  per check, without cookies or your Cutscene token. Addresses that could
  sign you out or change data (logout, delete, pay, ...) are not opened.
- Google Chrome opens the approval page during sign-in and the demo after
  sending (`open -b com.google.Chrome` on macOS, Chrome's own launcher on
  Windows and Linux; your default browser if Chrome is not found). Set
  `CUTSCENE_BROWSER` to use another browser, or `CUTSCENE_NO_BROWSER=1` to
  print the address instead.
- The notes on their way to the command-line tool: Claude saves them to
  `~/.config/cutscene/notes/<session>.md` (so it can add a line without
  writing them again). The file is deleted after the send, or after 24
  hours.
- Drafts: a dry run saves the exact notes it showed in
  `~/.config/cutscene/drafts` (mode 0600, kept 24 hours, at most 20), so what
  you approved is what is sent. The sign-in is saved in
  `~/.config/cutscene/credentials.json` with mode 0600 in a 0700 folder. The
  token is never printed.

The plugin has no hooks and no MCP server. It only runs when you ask for a
demo.

## The command-line tool

The skill drives `bin/cutscene`; you can run it yourself too.

```
cutscene login        Connect this computer to your Cutscene account
cutscene send         Send demo notes (markdown or JSON on stdin, --file or --body)
cutscene check-urls   Check that pages answer on this computer
cutscene status       Show which account is signed in
cutscene logout       Sign out and revoke this computer's token
```

`cutscene send --dry-run` checks the pages, saves a draft and prints what it
holds; `cutscene send --draft <id>` sends exactly that draft. Every command
takes `--help`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CUTSCENE_URL` | `https://trycutscene.com` | The Cutscene site. Must be `https://` except on localhost. |
| `CUTSCENE_CONFIG_DIR` | `~/.config/cutscene` | Where the sign-in and drafts are kept. |
| `CUTSCENE_BROWSER` | Google Chrome | Another browser to open pages in (an app name or bundle id on macOS, a program path elsewhere). |
| `CUTSCENE_NO_BROWSER` | unset | Set to `1` to print addresses instead of opening them. |
| `CUTSCENE_NODE` | found for you | The Node 18+ program to run the plugin with. |

Exit codes: 0 done, 1 failed, 2 wrong usage, 3 not signed in, 4 Cutscene
unreachable, 130 cancelled.

## Security

- Sign-in is the device flow (RFC 8628): you approve this computer in the
  browser.
- The token is only sent to the site that issued it, over HTTPS. If
  `CUTSCENE_URL` points somewhere else, the tool stops and asks you to sign
  in there. Redirects are never followed.
- `cutscene logout` revokes the token on the server and deletes the file.
  Each computer also appears under Connected apps in Cutscene settings, where
  you can revoke it.

## Uninstall

```
claude plugin uninstall cutscene@cutscene
```

Run `cutscene logout` first if you want the token revoked as well, or revoke
it under Connected apps in Cutscene settings.

## Support

Email [hello@trycutscene.com](mailto:hello@trycutscene.com) or open an issue
in this repository.

## License

The plugin in this repository is MIT licensed (see `LICENSE`). The Cutscene
service, website and Chrome extension are not part of this license.
