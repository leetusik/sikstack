---
name: setup
description: "Set sikstack up on this machine, once: save the email, make the install id, register it, set the session setting sikstack needs, and put `sikstack` in your terminal. Run it after installing the plugin, or again to change the email."
argument-hint: "[email]"
allowed-tools: Bash(sikstack setup:*), Bash(claude plugin configure:*), Bash(echo:*)
disable-model-invocation: true
---

# setup

One setup per machine. It needs no repo and no workspace, and nothing of your work leaves the machine: the server gets only the install id, the email and the plugin version.

1. **The email.** The email given with the command, if any: $ARGUMENTS. Otherwise the plugin's saved option, shown here between the brackets: [${user_config.email}]. If neither holds an email address (an empty or unsubstituted bracket counts as none), ask the user for one and wait for the answer.
2. **Save it as the plugin's option**, unless it equals the saved one above:

   ```
   echo '{"email":"<email>"}' | claude plugin configure sikstack@sikstack --values-stdin
   ```

   It applies from the next session (Claude Code says to restart), so this session goes on with the email from step 1. If the command fails, say so in one line and go on.
3. **Run the engine's setup** with that email and the plugin's data folder, exactly:

   ```
   sikstack setup --email "<email>" --data-dir "${CLAUDE_PLUGIN_DATA}"
   ```

   It keeps one install id in the data folder (a second run keeps it), registers `{install_id, email, plugin_version}` with the server (`https://sikstack.com`; the `SIKSTACK_SERVER` environment variable points it at another, such as a local stack), and sets `autoCompactWindow` to 500000 in your Claude Code user settings, changing nothing else there. It also writes `~/.local/bin/sikstack`, so `sikstack` runs in the user's own terminal too (Claude Code puts the plugin's commands on the PATH of its own shell only); `sikstack link`, which asks for a workspace key at a prompt, runs there. A file at that path setup did not write is left alone. When the server cannot be reached it still finishes: the registration is marked pending and the plugin's session-start hook registers it later.
4. **Report** what it printed, in a few lines: the install id, whether the registration landed or is pending, the settings line and the terminal command line (with its PATH hint, when it gives one). Then the next step: `/sikstack:sik-mode` in a repo.
