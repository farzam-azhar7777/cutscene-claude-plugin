# Cutscene for Claude Code

Ask Claude Code for a demo of what it just built. Claude writes a short demo
context (what changed, where to see it, the steps to show), shows it to you,
and sends it to your Cutscene account once you say yes. The Cutscene Chrome
extension then writes a narrated script from it and records the demo in your
own signed-in browser. You get one video and one share link.

Cutscene is free for 10 minutes of video a month (reset on the 1st). Paid
plans are on [trycutscene.com](https://trycutscene.com/#pricing).

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

## Use

After Claude has built something in a session, run:

```
/cutscene:demo
```

or just ask: "make a demo video of this". You can name what to show:
`/cutscene:demo the new invoice export`.

1. The first time, Claude signs you in. A code appears in the terminal and
   your browser opens Cutscene's approval page. Check that the codes match
   and choose Connect. No password or token is typed into the terminal.
2. Claude reads what changed (git status, log and the list of changed files)
   and writes the demo context: a title, a few sentences, the start URL and
   3 to 10 steps with the exact button labels.
3. You see the exact title, text and metadata that would be sent. Nothing
   goes out until you say yes.
4. Open your app in Chrome, open the Cutscene side panel and pick the context
   under "Latest from Claude Code". Review the script there, then record.

A demo can continue in another tab you have open (say, a payment provider's
test dashboard), wait until a result shows up, and hand you the steps only a
person can do, like attaching a file.

## What is sent, and where

The plugin talks to one site: `https://trycutscene.com`, under `/api/v1`.

| When | Request | What it carries |
| --- | --- | --- |
| Sign-in | `POST /device_authorizations`, then `POST /device_authorizations/token` | A device name for your Connected apps list ("Claude Code on" plus your computer's name; change it with `cutscene login --name`) |
| Status | `GET /me` | Your token, to show which account is signed in |
| Send | `POST /contexts` | The demo context below |
| Sign-out | `DELETE /token` | Revokes this computer's token |

The demo context is:

- A title and a short description written for a viewer: what changed, the
  start URL, the steps to show. At most 20 KB.
- Metadata: repository name (host/owner/name, with any login stripped),
  branch, commit, the paths of changed files, the app URL and the plugin
  version.

Never sent: source code, diffs, file contents, environment values, test
logins or customer data. If the text looks like it contains a password, key
or token, the tool refuses to send it.

How Cutscene stores and deletes this data: [privacy policy](https://trycutscene.com/privacy).
Terms: [trycutscene.com/terms](https://trycutscene.com/terms).

## What runs on your computer

- `bin/cutscene`, a Node script with no dependencies and no build step. The
  source in `lib/` is the code that runs.
- Read-only git commands (`rev-parse`, `symbolic-ref`, `config --get
  remote.origin.url`, `merge-base`, `diff --name-only`, `diff-tree`,
  `status --porcelain`) to fill in the metadata above.
- Your default browser opens the approval page during sign-in (`open` on
  macOS, `xdg-open` on Linux, `rundll32` on Windows). Set
  `CUTSCENE_NO_BROWSER=1` to print the address instead.
- The sign-in is saved in `~/.config/cutscene/credentials.json` with mode
  0600 in a 0700 folder. The token is never printed.

The plugin has no hooks and no MCP server. It only runs when you ask for a
demo.

## The command-line tool

The skill drives `bin/cutscene`; you can run it yourself too.

```
cutscene login     Connect this computer to your Cutscene account
cutscene send      Send demo context (markdown or JSON on stdin, --file or --body)
cutscene status    Show which account is signed in
cutscene logout    Sign out and revoke this computer's token
```

`cutscene send --dry-run` prints exactly what would be sent. Every command
takes `--help`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CUTSCENE_URL` | `https://trycutscene.com` | The Cutscene site. Must be `https://` except on localhost. |
| `CUTSCENE_CONFIG_DIR` | `~/.config/cutscene` | Where the sign-in is kept. |
| `CUTSCENE_NO_BROWSER` | unset | Set to `1` to print the approval address instead of opening it. |

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
service, web app and Chrome extension are not part of this license.
