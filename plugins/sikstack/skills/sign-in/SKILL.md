---
name: sign-in
description: "Sign this machine's sikstack install in to your account and see this repo's work on the web: prints a code, opens the connect page, and links the repo once you confirm there. Run it in a repo with a .sikstack/ workspace, after /sikstack:setup."
allowed-tools: Bash(sikstack sign-in:*)
disable-model-invocation: true
---

# sign-in

It claims this machine's install for the account you confirm on the web, and links this repo's workspace to a project named after the repo's folder. Only the code you confirm on the connect page claims the install: the setup email alone never does.

1. **Run the engine's sign-in** with the plugin's data folder, exactly, with the Bash tool's timeout at its maximum (600000 ms):

   ```
   sikstack sign-in --data-dir "${CLAUDE_PLUGIN_DATA}"
   ```

   Add `--release` when the user's arguments hold the word `release`, when the user says this install belongs to the wrong account, or when the connect page said "Connected to another account": it first releases the install from the account that claimed it (one `released:` or `release:` line), then goes on with a new code. A server that cannot release says so in one line and nothing changes.

   It prints a short code and the connect page's address and opens the page in the browser. As soon as those two lines appear, tell the user: open the page (if it did not open), check it shows the same code, sign in or create an account there, and press **Connect**.
2. **Wait for it.** It ends by itself once the page is answered:
   - `linked:` and `on the web:` lines: the install is connected; the repo's earlier work was uploaded. Relay the web address.
   - `still waiting` (exit 3): run the same command again; it keeps the same code while it lives.
   - a declined or expired code, or a refusal (an already linked checkout, uncommitted changes in `.sikstack/`): relay the one line it printed.
3. **Never print or ask for a key.** The key comes from the server once and goes straight into your user config; the command never shows it.
