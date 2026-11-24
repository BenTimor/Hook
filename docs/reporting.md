# Reporting AI output

The Report action on every reply, the content report for someone else's words, and the review queue behind both.

Every completed assistant reply has a **Report** action, in the chat window and
in a product's docked chat alike — the dialog and the action are part of
`packages/chat`, and a product that shows generated text supplies the handler
(`ChatTransport.report`); without one the action is hidden rather than shown and
broken. The dialog sends the reply, a reason, an optional note, and — only when
“Include the whole conversation” is ticked — the current chat's messages, to
`POST /api/reports` with the signed-in token. Reports are stored in the `ai_reports` table and the
privacy policy records exactly what a report contains.

Review and resolve them on the server:

```bash
./scripts/ai-reports.sh --list
./scripts/ai-reports.sh --show 12
./scripts/ai-reports.sh --resolve 12
```

The Store requires this mechanism (policy 11.16); see
[Microsoft Store (MSIX)](microsoft-store.md). Workspace will need the same
listing disclosure and Partner Center declaration before it can be submitted.

A preview can also show something a *person* wrote — a task's comments, a
document — and that is user-generated content, which App Store guideline 1.2
and the Play Console's UGC policy require a flag for. The same dialog does it
(`ReportContentDialog`): same reasons, same review queue, `subject_kind`
`"content"` and a `target` naming the entity instead of a message id, with the
comment or document as the evidence. `./scripts/ai-reports.sh --list` marks
which kind each row is.

---

[Documentation](README.md) · [Hook](../README.md)
