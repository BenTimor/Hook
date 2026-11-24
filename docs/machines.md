# Your machines

Running coding work on another computer of the same account, and the folder picker a controller may reach.

A paid account with cloud sync on can run coding work on any computer connected
to the same account. Hook is the host; Hook Workspace and HookCode are
controllers, so they can start, steer and stop work on a host but never run an
agent themselves.

- **The list.** **Settings → Your machines** shows every machine Hook has seen:
  its editable name, platform, app version, whether it is online, and whether it
  accepts remote work. A machine appears while Hook is running on it; turning
  the last switch off stops it accepting commands without removing it.
- **Starting work.** The chat agent calls `list_machines` and chooses: the
  machine the user named, the one this project ran on last, or the only one
  online. If none are on it says so and starts nothing; if several are possible
  it asks one short question with their names. Every agent tool takes the
  machine, even when there is only one, so the conversation records where each
  run happened.
- **Live.** A run on another machine publishes the same stream the local window
  draws: the answer, the plan, the status line. Close the laptop's window and
  the tray keeps Hook and its agents running; **Quit Hook** in the tray stops
  them. The phone can watch the same conversation and steer it.
- **Previews.** A preview served by a computer is opened through
  `<ticket>.preview.hookcode.io`, with the account service as the middleman. The
  machine dials out; nothing needs a forwarded port. The ticket is short-lived
  and only reaches the active preview for that conversation.
- **Requirements.** Remote control is part of a paid plan and requires cloud
  sync on. A free account can still use its own model endpoint for local agents;
  it cannot reach another machine.
- **Direct coding chats** (the user talking to `pi` themselves) can live on
  another machine too. The New chat menu offers **Coding agent on another
  machine…**; choose a host and one of its projects, create a new project
  there, or **Browse folders…** to start anywhere on that machine the local
  picker could reach (directories are listed one level at a time, never a
  file's contents). A folder picked that way is not registered as a project —
  it is the chat's folder, exactly as **Coding agent…** does on this computer.
  A folder's star in that picker pins it **on the host**: it is the same
  shortcut from every device of the account, and it is where the picker opens
  next time (Home, Projects and the drives follow it). Pins live in that
  machine's `settings.json`, so they are per-machine, at most twelve, and
  survive a restart.
  The host keeps the folder, the engine and the
  session. Only a small stub syncs — title, machine, live
  state, message count — never the transcript, a path or a session id. Opening
  the chat on another device fetches the conversation over the relay and caches
  it locally; that cache never uploads. If the host is offline, the cached copy
  opens instead. Steering, stopping and renaming still reach the host; changing
  the folder happens on the machine that owns it, because the folder and the
  engine only exist there. Deleting a cached chat also goes to the host — it
  removes the original there and queues the stub, which is why it needs that
  machine to be online — and then drops the copy here.

---

[Documentation](README.md) · [Hook](../README.md)
