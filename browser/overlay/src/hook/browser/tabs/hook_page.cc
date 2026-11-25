// Hook Browser: reading a tab's text for the chat agent.

#include "hook/browser/tabs/hook_page.h"

#include <string>
#include <utility>

#include "base/json/json_reader.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/common/chrome_isolated_world_ids.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"

namespace hook {

namespace {

// Walk the DOM and keep the words, with a newline between block elements. It
// deliberately asks the page for nothing but its text: no markup is sent
// anywhere, so a page cannot smuggle HTML into the conversation.
//
// The container is the largest of `article`/`main`/[role=main] when the page has
// one (a docs page, a blog post, a Wikipedia article), and `body` otherwise. The
// usual furniture — nav, sidebars, footers, forms, hidden nodes — is dropped
// while walking rather than stripped afterwards, because that is what keeps a
// 60k-character sidebar out of the answer.
constexpr char kReadScript[] = R"JS(
(function () {
  var skip = 'script,style,noscript,template,svg,canvas,iframe,nav,aside,footer,form,' +
             '[role="navigation"],[role="banner"],[role="contentinfo"],[aria-hidden="true"]';
  var candidates = ['article', 'main', '[role="main"]'];
  var root = null, best = 0;
  for (var i = 0; i < candidates.length; i++) {
    var nodes = document.querySelectorAll(candidates[i]);
    for (var j = 0; j < nodes.length; j++) {
      var len = (nodes[j].innerText || '').length;
      if (len > best) { root = nodes[j]; best = len; }
    }
  }
  if (!root) { root = document.body; }
  if (!root) { return JSON.stringify({ text: '', headings: [] }); }

  var blocks = /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|LI|UL|OL|DL|DT|DD|TR|TD|TH|TABLE|H[1-6]|BLOCKQUOTE|PRE|FIGURE|FIGCAPTION|ADDRESS|DETAILS|SUMMARY)$/;
  var out = [];
  function walk(node, depth) {
    if (node.nodeType === 3) {
      var words = node.nodeValue;
      if (words && words.trim()) { out.push(words.replace(/\s+/g, ' ')); }
      return;
    }
    if (node.nodeType !== 1 || depth > 80) { return; }
    if (node.matches(skip)) { return; }
    if (node.tagName === 'BR') { out.push('\n'); return; }
    var block = blocks.test(node.tagName);
    if (block) { out.push('\n'); }
    for (var child = node.firstChild; child; child = child.nextSibling) {
      walk(child, depth + 1);
    }
    if (block) { out.push('\n'); }
  }
  walk(root, 0);

  var text = out.join('')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  var headings = [];
  var all = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (var k = 0; k < all.length && headings.length < 300; k++) {
    var label = (all[k].innerText || '').replace(/\s+/g, ' ').trim();
    if (label) {
      headings.push({ level: parseInt(all[k].tagName.substring(1), 10),
                      text: label.substring(0, 160) });
    }
  }
  return JSON.stringify({ text: text, headings: headings });
})()
)JS";

constexpr char kSelectionScript[] = R"JS(
(function () {
  return String(window.getSelection() || '');
})()
)JS";

// A frame can go away while a script is in flight (the tab is closed, the
// renderer is killed, the page navigates). `WrapCallbackWithDefaultInvokeIfNotRun`
// is what keeps a tool call from hanging on a tab that is already gone.
void OnReadReply(PageReadCallback done,
                 PageRead page,
                 base::Value value) {
  if (!value.is_string()) {
    page.error = "That tab did not return any text.";
    std::move(done).Run(std::move(page));
    return;
  }
  std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(value.GetString(), base::JSON_PARSE_RFC);
  if (!parsed) {
    page.error = "That tab did not return any text.";
    std::move(done).Run(std::move(page));
    return;
  }
  if (const std::string* text = parsed->FindString("text")) {
    page.text = *text;
  }
  if (const base::ListValue* headings = parsed->FindList("headings")) {
    page.headings = headings->Clone();
  }
  const std::string capped = CapText(page.text, kMaxPageChars);
  page.truncated = capped.size() != page.text.size();
  page.text = capped;
  page.ok = true;
  std::move(done).Run(std::move(page));
}

}  // namespace

std::string PageUrl(const GURL& url) {
  if (!url.is_valid()) {
    return std::string();
  }
  GURL::Replacements strip;
  strip.ClearRef();
  if (url.has_username() || url.has_password()) {
    strip.ClearUsername();
    strip.ClearPassword();
  }
  return url.ReplaceComponents(strip).possibly_invalid_spec();
}

std::string CapText(std::string text, size_t chars) {
  size_t index = 0;
  size_t count = 0;
  while (index < text.size() && count < chars) {
    const unsigned char lead = static_cast<unsigned char>(text[index]);
    size_t width = 1;
    if (lead >= 0xF0) {
      width = 4;
    } else if (lead >= 0xE0) {
      width = 3;
    } else if (lead >= 0xC0) {
      width = 2;
    }
    index += width;
    ++count;
  }
  if (index < text.size()) {
    text.resize(index);
  }
  return text;
}

void ReadPage(content::WebContents* contents, PageReadCallback done) {
  content::RenderFrameHost* frame =
      contents ? contents->GetPrimaryMainFrame() : nullptr;
  if (!frame) {
    PageRead page;
    page.error = "That tab is no longer open.";
    std::move(done).Run(std::move(page));
    return;
  }

  PageRead page;
  page.title = base::UTF16ToUTF8(contents->GetTitle());
  page.url = PageUrl(contents->GetLastCommittedURL());

  frame->ExecuteJavaScriptInIsolatedWorld(
      base::UTF8ToUTF16(std::string(kReadScript)),
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(&OnReadReply, std::move(done), std::move(page)),
          base::Value()),
      ISOLATED_WORLD_ID_CHROME_INTERNAL);
}

void ReadSelection(content::WebContents* contents, SelectionCallback done) {
  content::RenderFrameHost* frame =
      contents ? contents->GetPrimaryMainFrame() : nullptr;
  if (!frame) {
    std::move(done).Run(std::string());
    return;
  }
  frame->ExecuteJavaScriptInIsolatedWorld(
      base::UTF8ToUTF16(std::string(kSelectionScript)),
      mojo::WrapCallbackWithDefaultInvokeIfNotRun(
          base::BindOnce(
              [](SelectionCallback callback, base::Value value) {
                std::string selection =
                    value.is_string() ? value.GetString() : std::string();
                std::move(callback).Run(
                    CapText(std::move(selection), kMaxSelectionChars));
              },
              std::move(done)),
          base::Value()),
      ISOLATED_WORLD_ID_CHROME_INTERNAL);
}

}  // namespace hook
