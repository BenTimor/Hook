import { toast } from "sonner";

import { ReportDialog as SharedReportDialog } from "@hook/chat";

import { api } from "../lib/bridge";
import type { Message } from "../lib/types";
import { useChatStore } from "../store/useChatStore";

/**
 * The chat app's report flow: the dialog comes from `@hook/chat`, and this
 * wrapper is the only part that knows about the IPC command and the toast.
 */
export function ReportDialog({
  chatId,
  message,
  onClose,
}: {
  chatId: string;
  message: Message;
  onClose: () => void;
}) {
  const messages = useChatStore((s) => s.messages);

  return (
    <SharedReportDialog
      messages={messages}
      onClose={onClose}
      submit={async (input) => {
        await api.reportMessage({
          chatId,
          messageId: message.id,
          reason: input.reason,
          note: input.note,
          content: message.content,
          transcript: input.transcript,
        });
        toast.success("Report sent. Thank you.");
      }}
    />
  );
}
