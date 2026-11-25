// Hook Browser: reading a tab's text for the chat agent.
//
// What the model gets is a *read*, on demand: the message carries the active
// tab's address, title and selection (cheap, always useful), and the page's text
// only when the agent asks for it with `read_page`/`find_in_page`. That split is
// the whole point — a page's text is tens of thousands of tokens, and a model
// that is handed one for every message spends the conversation's budget on
// pages it was not asked about.
//
// The script runs in an isolated world (`ISOLATED_WORLD_ID_CHROME_INTERNAL`), so
// the page's own JavaScript cannot see or shadow it, and it only reads: no
// mutation, no navigation, no form state. Text is capped here, before it leaves
// the browser, and the backend caps what the model sees again.

#ifndef HOOK_BROWSER_TABS_HOOK_PAGE_H_
#define HOOK_BROWSER_TABS_HOOK_PAGE_H_

#include <string>

#include "base/functional/callback.h"
#include "base/values.h"
#include "url/gurl.h"

namespace content {
class WebContents;
}  // namespace content

namespace hook {

// How much of a page travels in one read. A long docs page is around this; a
// feed page is far more, and the agent pages through it with offsets rather than
// receiving a hundred thousand tokens in one tool result.
constexpr size_t kMaxPageChars = 200000;

// The user's highlight, as it appears in the message's context frame.
constexpr size_t kMaxSelectionChars = 4000;

// A URL as the model is told about it: no fragment (an anchor is not part of
// "which page is this"), no credentials. A page read is a sentence in a
// conversation, so it is the address a person would read aloud.
std::string PageUrl(const GURL& url);

// Trims UTF-8 text to `chars` characters without splitting one.
std::string CapText(std::string text, size_t chars);

struct PageRead {
  bool ok = false;
  std::string error;
  std::string title;
  std::string url;
  std::string text;
  // Heading rows: `{level, text}`. The offsets into `text` are computed by the
  // backend, which is the half that has the text; the browser only knows order.
  base::ListValue headings;
  // True when the page was longer than `kMaxPageChars`.
  bool truncated = false;
};

using PageReadCallback = base::OnceCallback<void(PageRead)>;

// Reads `contents`'s visible text and headings. The callback always runs.
void ReadPage(content::WebContents* contents, PageReadCallback done);

// The user's current highlight in `contents`, or an empty string. Always calls
// back, capped at `kMaxSelectionChars`.
using SelectionCallback = base::OnceCallback<void(const std::string& selection)>;
void ReadSelection(content::WebContents* contents, SelectionCallback done);

}  // namespace hook

#endif  // HOOK_BROWSER_TABS_HOOK_PAGE_H_
