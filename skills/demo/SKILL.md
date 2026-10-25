---
name: demo
description: Use when the user asks for a demo video, Cutscene, walkthrough or screen recording of what was built in this session ("make a demo video of this", "record a demo", "make a cutscene", "demo the billing page", "send the updated demo"). Writes complete demo notes from the session and the code, checks the pages, shows a summary, and after an explicit Send hands them to the Cutscene panel in Chrome, which writes the script and records. Not for unrelated video, screenshot or documentation requests.
argument-hint: "[what to demo]"
allowed-tools: Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(git branch:*), Bash(git grep:*), Bash(git ls-files:*), Bash(${CLAUDE_PLUGIN_ROOT}/bin/cutscene *), Bash(${CLAUDE_PLUGIN_ROOT}/bin/cutscene-facts *), Edit(~/.config/cutscene/notes/**)
---

# Send a demo to Cutscene

You write the demo notes; Cutscene's Chrome extension turns them into a
narrated script, chapter by chapter, and records it in the user's own
signed-in browser. The better the notes, the less the user does: they should
only read your summary, choose Send, and press Write script in Chrome.

## Always

1. Cover every visible behaviour built in this session. Each one is a step or
   an "Expect" in a chapter. Nothing is too small: a new button, a dialog and
   its Cancel, a toast, an empty state, a validation message, a rule about
   when something shows.
2. Name every element exactly: its visible label in quotes, its role (button,
   link, tab, checkbox, menu, field, dialog) and an identifier from the code
   when there is one (id, name, data-testid or another data attribute,
   aria-label). Use real addresses with real ids.
3. No word limit. Write as much as the demo needs; the only cap is 20 KB.
4. Never put source code, diffs, file contents, secrets, keys, tokens,
   passwords, test logins, environment values or customer data in the notes.
   For an account write "Start signed in as ..." (the browser is signed in).
5. Ask only when you are unsure and the answer changes the video (section 4).
   Use the AskUserQuestion tool. Never ask what the session, the code or the
   page check already answers, and never ask the same thing twice.
6. Never send without the user choosing Send (or Send update). Anything else,
   a timeout too, means nothing is sent.
7. Never open a browser, use browser tools, curl or fetch pages yourself. The
   CLI checks pages and opens Chrome.
8. No permission prompts: search and read with the Grep, Glob and Read
   tools, never with `grep`, `rg`, `ls`, `cat`, `find`, `head`, `sed` or
   `node` in Bash (data files and seeds too). The only Bash commands are the
   git commands above and the Cutscene CLI, called by its full path
   `"${CLAUDE_PLUGIN_ROOT}/bin/cutscene"` (written `cutscene` below), one
   plain command per call: never `cd` (you are already in the project), and
   no `&&`, `;`, `|`, `head`, `mktemp`, `rm` or heredocs. To narrow a search,
   use the Grep tool's own options (path, glob, head_limit), not a pipe. The
   only file you write is the notes file in section 3, with the Write tool.
   Those are pre-approved, so the user is never stopped by a prompt. Never
   read, print or ask for the Cutscene token or open anything in
   `~/.config/cutscene` except writing the notes file.
9. Plain words in everything the user reads. No em dashes.
10. After a send, the pre-approval ends with your turn. In any later message,
    run this skill again with the Skill tool before any Cutscene command
    (section 7), and do so by yourself when you finish a change to the app
    that a viewer would see, even if the user did not mention the demo.

## What to do now

The user's words: $ARGUMENTS

- `send draft <id>`: the user already chose Send; send that draft now
  (section 6) and do nothing else.
- `change: <what>`: apply it to the notes you last showed in this
  conversation, then go on from section 3 (keep `--update` if the last dry
  run had it).
- `update: <what changed>`: the app changed after a send. Do everything from
  section 1 with `--update` in section 3.
- Anything else names what to demo (or nothing: the whole session). Focus
  on it, but still cover every visible part of it.

## 1. Gather (read only)

1. Read the Session facts at the end of this message. They come from this
   session's transcript on disk (what the user asked, what you said you did,
   the files you changed, the commands you ran, the addresses you used), git
   and the project. They can hold more than you remember after a compaction.
   If they are missing or say "unavailable", use the conversation and run
   `git status --short`, `git log --oneline -15` and `git diff --stat`.
2. List for yourself every visible behaviour built in this session, from
   "What the person asked", "What Claude said it did" and the changed files.
3. Read the code a viewer sees, in the facts' order: routes, then views,
   templates and components, locale files (for exact labels), controllers,
   system and end-to-end tests (`click_on "Save"`, `getByRole("button",
   { name: "Save" })` give exact labels and flows). Read only what you need
   for labels, roles, identifiers, addresses and the order of the flow.
4. Find the start address: the dev server and the addresses used in this
   session first, then the facts' dev-server hints. Use the host and port the
   dev server answers on. Never guess a port.
5. Find what the demo needs to exist (a record with the right state, a
   role) and whether the session or the seed data creates it.

## 2. Write the notes

Shape (markdown, one chapter per part of the work, in the order a viewer
would follow it):

```markdown
# <What the feature lets someone do, under 60 characters>

<One to three sentences: what changed for the user and why it matters.>

## Who it's for
- <who watches: "the team", "Dana at Northwind (the client who asked for it)">

## Where to see it
- Start at: <exact first address>
- Start signed in as <a user who can ...>
- Needs: <data that must exist, e.g. "an overdue invoice with a balance (INV-1051)">

## Chapters

### 1. <What the viewer learns in this part>
Start at: <exact address of this chapter's first page>
1. Click the "Overdue" filter chip (link, href ?status=overdue). Expect only overdue invoices, each with a red "Overdue" badge.
2. Click "INV-1051" in the first row (link). Expect the invoice page /invoices/51 with "Balance due $552.50".

### 2. <Next part>
Start at: <exact address>
1. Click "Mark as paid" (button, id mark-paid). Expect a dialog: "Record a payment of $552.50 and mark INV-1051 as paid?"
2. Click "Cancel" in the dialog (button). Expect the dialog to close and nothing to change.
...

## Worth pointing out
- <a rule or detail a viewer should notice, e.g. "The button shows only on sent and overdue invoices.">
```

Rules for the chapters:

- Every step: the action, the exact element (label, role, identifier), then
  "Expect" and what visibly happens. One step per thing the viewer should
  notice.
- Group small actions that make one point into one step: "Click Mon, Tue,
  Wed, Thu and Fri in the day picker (buttons, data-day). Expect all five
  highlighted." Typing into a field and pressing Enter is one step.
- Results that arrive later (a job, a webhook, an email): a wait, not a
  pause: "Wait until "Paid" shows on the invoice (a background job)."
- Parts only a person can do (choosing a file, typing a password, card
  number or one-time code, a phone, another app): first person, as the
  user's turn: "My turn: I attach the receipt myself."
- Another site the user has open (a payment dashboard, an inbox): name it
  and its address: "In the Stripe dashboard tab (dashboard.stripe.com):
  capture the payment for INV-1051." Most demos stay in one app.
- Chapters can be as many as the work needs; a chapter usually has 3 to 10
  steps. Never drop a part to keep it short.
- Who it's for: a name only from the session, the pull request or the
  branch. Otherwise "the team" (the video greets neutrally).
- Production or staging: use that address only when the user asked for it.

Before the dry run, check the notes against your list from step 1.2: every
behaviour appears in a chapter. Behaviours a viewer cannot see in one
signed-in browser (another role, an email you cannot open) go under "Worth
pointing out".

## 3. Dry run (checks the pages, saves a draft)

Two calls, the same every time:

1. Save the whole notes with the Write tool to the "Notes file for the dry
   run" path in the Session facts (if the facts are unavailable:
   `~/.config/cutscene/notes/${CLAUDE_SESSION_ID}.md` with `~` written out
   as the home folder). It is a new file each time: the dry run deletes it
   after reading.
2. Run, as one Bash command, with that same path:

```
"${CLAUDE_PLUGIN_ROOT}/bin/cutscene" send --dry-run --notes-file "<notes file path>"
```

Never put the notes on the command line (no heredoc, no `--body`): long
notes there make Claude Code stop and ask the user.

Add `--update` when these notes replace a demo this session already sent
(the facts say "Sent from this session before") and it is the same demo,
changed. A different feature is a new demo: no `--update`.

It prints `draft <id>`, the start address, each page's check, a summary
line such as "5 pages load. 1 page needs sign-in.", an "Also sent: ..." line
and the changed file names that go with the notes. Then:

- "not found": find the right address in the routes and fix the notes, then
  dry-run again. If you cannot find it, ask (App address, section 4).
- "nothing is running": ask "Your app is not answering at localhost:3000."
  (section 4).
- "needs sign-in": fine. Chrome is signed in; the page check sends no
  cookies.
- "redirects": use the address it ends on.
- A secret was found: remove that text and dry-run again. Never work around
  the check.

## 4. Questions, only when unsure

Ask only when all hold: the answer changes the video, it is not in the
session, the code, the config or the page check, and it was not asked
before. Put every question that applies in one AskUserQuestion call (1 to 4
questions, 2 to 4 options each, header up to 12 characters), before you show
the summary. Ask a follow-up only when an answer opens a new real doubt (for
example "Production" when the config has two production hosts).

| Header | Question | Ask when | Options |
|---|---|---|---|
| App address | Where should Cutscene record this demo? | no dev server seen in the session and more than one candidate; or the user asked for production or staging and the exact address is not certain | up to 4 found, each with where it came from ("localhost:3000": "The dev server you ran in this session"; "app.example.com": "Production, from config/deploy.yml") |
| Needs data | The demo needs <an overdue invoice with a balance>. Is it in the app now? | a chapter needs data or a role this session did not create and the page check cannot confirm | "Yes, it is there": "Record as planned"; "Add it in the demo": "A first chapter creates it"; "I will set it up": "Send now and set it up before Write script" |
| What to show | Which changes should the demo cover? (multiSelect) | the session built several unrelated features people can see and the request named none; or it built nothing a viewer can see (a library, a migration) and the request names nothing | up to 4 features or main pages, each with its page |
| Audience | Who will watch this demo? | the session clearly targets an outside viewer (a client, customers) with no name | "A client": "Type their name under Other to greet them"; "My team"; "PR reviewers"; "Customers" |

The app is not answering (after the dry run): one AskUserQuestion, header
"App", question "Your app is not answering at localhost:3000.", options
"Start it for me": "Runs <the dev command> in the background and checks
again", "I started it": "Checks again", "Send anyway": "Cutscene records it
later". Start it for me: run the dev command from the facts with Bash
`run_in_background`, then `cutscene check-urls --wait 60 <start address>`,
then the dry run again.

Never ask about voice, length, chapters, the title, capture, sign-in or the
user's turns. If AskUserQuestion is not available (for example `claude -p`),
ask the same questions in plain text and end your turn.

## 5. Show the summary and ask

Show exactly this shape (the page line is the dry run's summary line):

```
Here is the demo I will send to Cutscene.

"<title>", for <who>, starting at <localhost:3000/practices>, in <N> chapters:
1. <chapter 1 title>
2. <chapter 2 title>
<page line, e.g. "5 pages load. 1 page needs sign-in. If Chrome is not signed in there, Cutscene asks you to sign in before it writes.">
<the dry run's "Also sent: ..." line, word for word>
```

Then AskUserQuestion: header "Send", question "Send this to Cutscene?",
options "Send": "It opens in the Cutscene panel in Chrome", "Show full text":
"Every line and detail that goes", "Change something": "Type the change
under Other". For an update use the question "Send the updated demo to
Cutscene?" and "Send update": "The panel shows the new version in place of
the old one".

- Send or Send update: section 6.
- Show full text: show the whole notes as markdown, then from the dry run
  its Pages list, its "Also sent" line and its list of changed file names,
  then ask again.
- A typed change (under Other, or "Change something" with words): change the
  notes, dry-run again, show the summary again, ask again, all in this turn.
- "Change something" with no words: ask "What should I change?" and end
  your turn. The answer is a new message: section 7.
- Anything else, or no answer: say "Nothing was sent." and stop.

## 6. Send

Run `cutscene send --draft <id>` with the id from the latest dry run. It
sends those exact notes, opens Chrome and prints one line saying where the
notes are and what to press. Pass that line on to the user unchanged, with
nothing added.

- Exit 3 (not signed in, or the sign-in ended): run `cutscene login --start`.
  It opens the approval page in Chrome and prints a code. Tell the user:
  "Approve code `XXXX-XXXX` in the Cutscene tab that just opened in Chrome."
  Then run `cutscene login --wait` with a Bash timeout of 600000 ms, and on
  exit 0 run the same `cutscene send --draft <id>` again.
- Exit 4 (Cutscene not reachable): say "Cutscene is not reachable, so
  nothing was sent. The demo is saved for 24 hours: say "send it" when you
  are back online." When they do, that is a new message: section 7.
- Exit 1 or 2: show the CLI's message. "Draft ... is gone": dry-run again.

## 7. Later messages

The Cutscene commands are pre-approved only in the turn this skill runs in.
In a later message, never call the CLI directly (the user would get a
permission prompt): run this skill again with the Skill tool (skill
`cutscene:demo`) and one of these arguments. It refreshes the Session facts
and the pre-approval, then follows "What to do now".

- The user says what to change in the notes: `change: <their words>`.
- The user asks to send a saved draft (after exit 4): `send draft <id>`.
- After a send in this session, you finish a change to the app that a
  viewer would see, whether or not the user mentioned the demo:
  `update: <what changed, in one line>`. That run ends with "Send the
  updated demo to Cutscene?", and the panel then shows the new version in
  place of the old one. Skip it when a viewer would see nothing new (tests,
  refactoring, docs) or the user said they do not want the demo updated.

## Session facts

```!
"${CLAUDE_PLUGIN_ROOT}/bin/cutscene-facts" --session "${CLAUDE_SESSION_ID}" --project "${CLAUDE_PROJECT_DIR}"
```
