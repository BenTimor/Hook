# Importing from ChatGPT or Claude

Turning a vendor's own export into ordinary chats, without scraping anything.

Settings → **Import history** turns the ZIP that ChatGPT or Claude produce from
their own "export my data" setting into ordinary chats.

- **The file is the user's own copy.** Nothing signs in to either service and no
  request leaves the machine: `import.rs` reads the archive, flattens each
  conversation onto the branch the user actually saw and writes chats through
  `store.rs`. Both vendors' terms forbid automated extraction from their chat
  products, and both provide the export — this is the one route that needs
  neither a private endpoint nor a scraper.
- **Formats.** ChatGPT ships `conversations.json` (split across numbered files on
  large accounts) as a `mapping` tree marked with `current_node`; editing a prompt
  leaves abandoned siblings behind, so the reader walks the parent chain from
  `current_node` and drops the rest. Claude ships a flat `chat_messages` list
  whose visible branch is the parent chain of the newest leaf. Entries are probed
  by shape rather than by name, so numbered splits, `user.json` and Claude's
  `projects.json` are all handled. Accepted input: the ZIP, the extracted
  `conversations.json`, or the unzipped folder.
- **Ids are derived, never random.** A chat's id is `cgpt_<conversation id>` or
  `cld_<conversation id>`, and message ids come from the source's own message
  ids. That is what makes a second import an update instead of a duplicate — on
  this machine and on every other one signed in to the account.
- **Re-import.** `ChatMeta.sourceUpdatedAt` records the source's `updated_at` at
  the last import. While it still equals the chat's own `updatedAt` nobody has
  touched the conversation here, so a newer export replaces the contents. As soon
  as the user replies or renames it, the local version wins and that chat is
  reported as "kept as yours".
- **Not imported.** Pictures and files (ChatGPT points at `asset_pointer`s whose
  files are usually missing from the archive; Claude's export documents that
  uploads are excluded), regenerated branches, projects, memories and custom
  instructions. Transcripts arrive as text.
- **Sync.** Imported chats are marked dirty and pushed like any other, ten per
  batch, so a big import keeps uploading in the background. The account's 5,000
  chat and 250 MB conversation limits still apply.

---

[Documentation](README.md) · [Hook](../README.md)
