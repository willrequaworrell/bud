import type { TelegramMessage } from "eve/channels/telegram";

export function isOwnerPrivateText(
  message: TelegramMessage,
  ownerId: string,
): boolean {
  return (
    message.chat.type === "private" &&
    message.from?.id === ownerId &&
    message.text.trim().length > 0
  );
}
