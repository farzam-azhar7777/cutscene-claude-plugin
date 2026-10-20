---
name: demo
description: Use when the user asks for a demo video, Cutscene, walkthrough or screen recording of what was just built in this session ("make a demo video of this", "record a demo", "make a cutscene", "demo the billing page"). Writes the demo context from what changed, shows it to the user, and sends it to their Cutscene account for the Chrome extension to script and record. Not for unrelated video, screenshot or documentation requests.
argument-hint: "[what to demo]"
allowed-tools: Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(git rev-parse:*), Bash(git merge-base:*), Bash(git branch:*)
---

# Send a demo to Cutscene

You turn what was just built into a short demo context. Cutscene's Chrome
extension then writes a narrated script from it and records the demo in the
user's own signed-in browser. A demo can switch to other tabs the user has
open (a payment dashboard, an inbox), wait for results that arrive later, and
hand the user the steps only a person can do. You never record anything
yourself.

The CLI is `"${CLAUDE_PLUGIN_ROOT}/bin/cutscene"` (written `cutscene` below;
always call it by that full quoted path). Run each CLI command on its own, with
no `;`, `&&`, pipes or `echo $?`: the Bash result already shows the exit code,
and a plain command matches the user's permission rules. Never print, read,
copy or ask for the user's token, and never open `~/.config/cutscene`.

If the user said what to demo, focus on it: $ARGUMENTS

## 1. Check the sign-in

Run `cutscene status`.

- Exit 0: continue.
- Exit 3 (not signed in, or the sign-in was revoked): run
  `cutscene login --start`. It prints a code and an address and opens the
  browser. Tell the user: "Approve code `XXXX-XXXX` in the Cutscene tab that
  just opened (or open <address>)." Then run `cutscene login --wait` with a
  Bash timeout of 600000 ms. Exit 0: continue. Otherwise show its message and
  stop.
- Exit 4: Cutscene is not reachable. Tell the user the address it tried and
  to check their connection and try again (developers running their own
  Cutscene server set `CUTSCENE_URL`). Stop.

## 2. Work out what to show (read only)

Start from what you did in this conversation; git fills the gaps.

1. `git status --short`, then find the base: `git merge-base HEAD main`
   (or `master`). Run `git log --oneline -20 <base>..HEAD` and
   `git diff --stat <base>` (this includes uncommitted work).
2. Find the user-facing surface of the change: the routes or pages it added or
   changed (for example `config/routes.rb` and views in Rails,
   `app/**/page.tsx` or `pages/` in Next.js, route files in React Router).
   Read only enough to know the URL path, the exact visible labels (button
   text, headings, field labels) and the flow.
3. Find the app URL where the demo starts: the dev server you ran in this
   session, or `Procfile.dev`, `bin/dev`, `package.json` scripts, the
   framework default. If you are not sure, ask the user. Never guess a port.
4. If the change has nothing a viewer can see in a browser (a library, a CLI,
   a migration only), say so and ask the user what the demo should show.
5. Work out who will watch the video and why the change matters to them,
   from this conversation (a client who asked for it, the team, the
   reviewers of a pull request, customers). Use only names the user gave;
   never guess one. Cutscene's video opens by greeting them by that name
   and closes with a next step that fits them.

## 3. Write the context

Write it to a new temporary file (`mktemp -t cutscene.XXXXXX`). Use this shape:

```markdown
# <What the feature lets someone do, under 60 characters>

<One to three sentences: what changed for the user and why it matters.
Product language, not code.>

## Who it's for
- For: <who will watch: "Dana at Northwind (the client who asked for it)",
  "the reviewers of PR #128", "the team", "new customers">
- Why it matters to them: <the problem it solves for them, in their words>

## Where to see it
- Start at: <exact app URL>
- Needs: <state the viewer needs, e.g. "an account with at least one invoice">

## Steps to show
1. <Where to start and what is on screen>
2. Click "<exact visible label>" ...
3. In the <other site> tab (<its address>): <what happens there>
4. Back in the app: wait until "<exact text>" shows up
5. My turn: I <what the person does> myself
6. ...

## Worth pointing out
- <a detail a viewer should notice>
```

Rules:

- 120 to 400 words and 3 to 10 steps. The hard limit is 20 KB.
- Always write "Who it's for". When the conversation does not say who will
  watch, write "For: not named" and ask about it in step 4.
- Quote exact visible labels ("Export CSV") so the recorder finds them.
- Start on the app URL. Write steps 3 to 5 of the shape above only when the
  flow needs them; most demos stay in one app.
- Another site: when the flow continues in a different app the user has
  open in Chrome (a payment provider's test dashboard, a webmail inbox, an
  admin tool), name the site and its address and say what happens there:
  "In the payments dashboard tab (dashboard.example.com), capture the
  payment for invoice 1042." Up to three other tabs.
- Results that arrive later (a webhook, a background job, an email): write a
  wait, not a pause: "Wait until "Paid" shows up on the invoice."
- Parts only a person can do: choosing a file, a desktop app or chat app,
  a phone, a captcha, typing a password, card number or one-time code. Write
  them in the first person as the person's turn: "I attach the receipt
  myself." Cutscene hands those over; the person does them and talks.
- Never include source code, diffs, file contents, secrets, API keys, tokens,
  passwords, test logins, environment values or customer data. If the flow
  needs an account, write "Start signed in as a user who ...": the extension
  records in a browser that is already signed in.
- Plain words, no em dashes.

## 4. Show it and get a yes

Run `cutscene send --dry-run --app-url "<app URL>" --file <path>`. It prints
the exact payload, including the metadata the CLI adds: repo, branch, commit,
changed file paths (never contents) and the app URL.

Show the user the title, the body as markdown and that metadata, then ask:
"Send this to Cutscene?" Wait for a clear yes. When "For" says "not named",
add: "Who will watch it? Give me a name (a client, your team) and the video
greets them; otherwise it opens with a general hello." If they want changes, edit the
file and show it again. Never send without their yes.

If the dry run stops because the text looks like it contains a secret, remove
that text from the file and run the dry run again. Never work around the check.

## 5. Send

Run `cutscene send --app-url "<app URL>" --file <path>`, then delete the file.

- Exit 0: tell the user: "Sent. Open <app URL> in Chrome, then open the
  Cutscene side panel (the Cutscene icon in the toolbar). Your context is
  waiting there, marked **From Claude Code**: review the script, then
  record." If the demo uses other sites, add: "Open <each other address> in
  the same Chrome window first, then choose those tabs under **Use other tabs
  too** before writing the script."
- Exit 3: do step 1 to sign in, then run the same send once more.
- Exit 4: Cutscene is not reachable. Keep the file, tell the user, and offer
  to send again when Cutscene is reachable.
- Exit 1 or 2: show the CLI's message; fix the input if it says how.
