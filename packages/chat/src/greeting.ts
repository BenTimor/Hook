/** The greeting the chat window and every dock use, so they agree. */
export function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 4) return "Still up?";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  if (hour < 23) return "Good evening";
  return "Still up?";
}
