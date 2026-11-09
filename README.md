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

- Claude Code (terminal, IDE extensions or the desktop app's Code tab)
- Google Chrome with the [Cutscene extension](https://chromewebstore.google.com/detail/cutscene/bheofgkkeaedknlnkaejmlgdimmphcbd)
- A Cutscene account. You can create one during the first sign-in.

The plugin is a skill and a connection to Cutscene's server. It ships no
programs: nothing to install besides the plugin itself.

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

## Sign in (once)

Run `/mcp` in Claude Code, choose `plugin:cutscene:cutscene`, then
Authenticate. Your browser opens Cutscene: sign in if you need to, check that
it says Claude Code wants to send demos to your Cutscene, and choose Allow.
If you ask for a demo before signing in, Claude tells you these same steps.

Nothing is typed into the terminal and no file with a key is written on your
computer: Claude Code keeps the sign-in in its own secure storage. The
connection shows under Connected apps in Cutscene settings, where Disconnect
ends it.

## Update

Plugins from this marketplace do not update by themselves. To get the newest
version:

```
claude plugin marketplace update cutscene
claude plugin update cutscene@cutscene
```

Then run `/reload-plugins`, or start a new session.

## Use

After Claude has built something in a session, run:

```
/cutscene:demo
```

or just ask: "make a demo video of this". You can name what to show:
`/cutscene:demo the new invoice export`.

1. Claude reads this session's record (what you asked, what it said it
   built, the addresses it used), your git branch and the code behind the
   pages, all on your computer. It writes the demo notes: one chapter per
   part of the work, each with its start page and steps like "Click "Mark as
   paid" (button). Expect a dialog ...". There is no word limit; the notes
   can be up to 20 KB.
2. It checks that the pages answer on your computer (loads, needs sign-in,
   not found) and fixes addresses that are wrong.
3. It asks you something only when it cannot tell from the session or the
   code, for example which address to record on when you ask for production.
   Every question comes with the option it recommends first.
4. Cutscene saves the notes as a draft (nothing is sent to the panel yet)
   and Claude shows you a summary: title, account, where it starts, the
   chapters, the page check and what else goes with the notes. Choose Send,
   Show full text (every line and detail) or Change something. Nothing goes
   to your panel until you choose Send.
5. On a Mac (and on Linux) Chrome opens and the notes show in the Cutscene
   panel; elsewhere open the link Claude gives you. Press Write script: the
   script is written, voiced and recorded without more clicks.

Change something after sending, and Claude asks whether to send the updated
demo; the panel shows the new version in place of the old one, and recording
it keeps the link you already shared.

A demo can continue in another tab you have open (say, a payment provider's
test dashboard), wait until a result shows up, and hand you the steps only a
person can do, like attaching a file.

## What is sent, and where

The plugin talks to one server: `https://trycutscene.com/mcp` (Cutscene's MCP
server), signed in with OAuth.

| When | Tool | What it carries |
| --- | --- | --- |
| Before the summary | `cutscene_prepare` | The demo notes below; Cutscene checks them for passwords, keys and tokens and keeps them as a draft for 24 hours |
| After you choose Send | `cutscene_send` | The draft's id: the panel gets exactly the notes you saw |
| To update a demo | `cutscene_list_demos` | Nothing: lists the demos you sent from Claude Code |
| When you ask whether Cutscene is set up | `cutscene_status` | Nothing: answers your account, plan, minutes left and whether the extension is connected |

The demo notes are:

- What a viewer needs: a title, a short description, who the video is for,
  where to start, and the chapters with their steps. At most 20 KB.
- With them: the repository name (host/owner/name, with any login left out),
  the branch, the paths of changed files (names only, most useful first;
  images, fonts, lockfiles and build output left out) and the result of the
  page check for each page (loads, needs sign-in, not found, ...).

Not sent: Claude is told never to include source code, diffs, file contents,
environment values, test logins or customer data. Before you choose Send you
see a summary, and Show full text shows every line and every detail that
goes with it. If the text looks like it contains a password, key or token,
Cutscene refuses to save it. The session record is read on your computer to
write the notes and is never sent.

How Cutscene stores and deletes this data: [privacy policy](https://trycutscene.com/privacy).
Terms: [trycutscene.com/terms](https://trycutscene.com/terms).

## What runs on your computer

The plugin ships no programs, hooks or scripts. While you ask for a demo,
the skill lets Claude use these without asking you each time:

- Claude's own Read, Grep and Glob tools on this session's record in
  `~/.claude/projects` (searching what you asked and what Claude said it
  built; never sent anywhere).
- Read-only git commands: `status`, `log`, `diff`, `show`, `rev-parse`,
  `merge-base`, `branch`, `symbolic-ref`, `config --get remote.origin.url`,
  `grep`, `ls-files`.
- The page check: `curl -s -o /dev/null` to addresses on this computer only
  (localhost, 127.0.0.1), one GET each with a time limit, without cookies.
  It prints only the status code and where a redirect goes. Addresses that
  could sign you out or change data (logout, delete, pay, ...) are not
  opened.
- After you choose Send, opening the panel link
  (`https://trycutscene.com/go/...`) in Chrome: `open -b com.google.Chrome`
  on macOS, `xdg-open` on Linux.
- The four Cutscene tools above.

If the page check finds your app is not running and you choose "Start it for
me", Claude Code asks you before it runs your dev command.

## Security

- Sign-in is OAuth 2.1 with PKCE in your browser. You approve Claude Code on
  Cutscene's own page; the plugin never sees your password or reads a key
  from your computer.
- Disconnect it any time under Connected apps in Cutscene settings, or
  clear it in Claude Code with `/mcp`.

## Uninstall

```
claude plugin uninstall cutscene@cutscene
```

Disconnect it under Connected apps in Cutscene settings if you want the
sign-in ended as well.

## Support

Email [hello@trycutscene.com](mailto:hello@trycutscene.com) or open an issue
in this repository.

## License

The plugin in this repository is MIT licensed (see `LICENSE`). The Cutscene
service, website and Chrome extension are not part of this license.
