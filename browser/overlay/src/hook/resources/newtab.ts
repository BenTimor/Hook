// Hook Browser: the new tab page's one behaviour.
//
// A greeting that is true of the clock. Nothing else is dynamic: the chips are
// links, and a page that greets you and gets out of the way does not need a
// framework. When the page grows a real job (recent chats, a search box) this is
// where the mojom seam already exists — `chrome://hook` is a page away.

const greeting = document.querySelector<HTMLHeadingElement>('#greeting');

function lineFor(hour: number): string {
  if (hour < 5) return 'Still up?';
  if (hour < 12) return 'Good morning.';
  if (hour < 18) return 'Good afternoon.';
  if (hour < 23) return 'Good evening.';
  return 'Still up?';
}

if (greeting) {
  greeting.textContent = lineFor(new Date().getHours());
}
