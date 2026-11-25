// Hook Browser: the live tab list.

#include "hook/browser/tabs/hook_tabs.h"

#include <utility>

#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/ui/browser_window/public/browser_collection.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/web_contents.h"
#include "hook/browser/tabs/hook_page.h"
#include "url/gurl.h"

namespace hook {

namespace {

// Every window, in the order the user opened them.
std::vector<BrowserWindowInterface*> Windows() {
  std::vector<BrowserWindowInterface*> windows;
  GlobalBrowserCollection* browsers = GlobalBrowserCollection::GetInstance();
  if (!browsers) {
    return windows;
  }
  // ForEach, not GetBrowsers: the collection exposes iteration publicly and
  // keeps the ordering to itself.
  browsers->ForEach(
      [&windows](BrowserWindowInterface* browser) {
        if (browser) {
          windows.push_back(browser);
        }
        return true;
      },
      BrowserCollection::Order::kCreation);
  return windows;
}

// The window whose tabstrip `web_contents` belongs to, or null.
BrowserWindowInterface* FindWindow(const content::WebContents* web_contents) {
  GlobalBrowserCollection* browsers = GlobalBrowserCollection::GetInstance();
  return browsers ? browsers->FindBrowserWithTab(web_contents) : nullptr;
}

}  // namespace

std::vector<HookTab> ReadAllTabs() {
  std::vector<HookTab> rows;
  int number = 0;
  const std::vector<BrowserWindowInterface*> windows = Windows();
  for (size_t w = 0; w < windows.size(); ++w) {
    const TabStripModel* model = windows[w]->GetTabStripModel();
    if (!model) {
      continue;
    }
    const int active_index = model->active_index();
    for (int i = 0; i < model->count(); ++i) {
      content::WebContents* tab = model->GetWebContentsAt(i);
      if (!tab) {
        continue;
      }
      ++number;
      const GURL& url = tab->GetLastCommittedURL();
      HookTab row;
      // A page read takes the number, so it starts at one rather than zero: it
      // is read by a person and by a model, not by an index.
      row.index = number - 1;
      if (tabs::TabInterface* tab_interface = model->GetTabAtIndex(i)) {
        row.id = tab_interface->GetHandle().raw_value();
      }
      row.window = static_cast<int>(w) + 1;
      row.active = (i == active_index);
      row.title = base::UTF16ToUTF8(tab->GetTitle());
      row.url = PageUrl(url);
      row.domain = std::string(url.host());
      rows.push_back(std::move(row));
    }
  }
  return rows;
}

content::WebContents* FindTabByNumber(int number) {
  if (number < 1) {
    return nullptr;
  }
  int seen = 0;
  for (BrowserWindowInterface* browser : Windows()) {
    const TabStripModel* model = browser->GetTabStripModel();
    if (!model) {
      continue;
    }
    for (int i = 0; i < model->count(); ++i) {
      if (!model->GetWebContentsAt(i)) {
        continue;
      }
      ++seen;
      if (seen == number) {
        return model->GetWebContentsAt(i);
      }
    }
  }
  return nullptr;
}

content::WebContents* ActiveTabIn(const content::WebContents* anchor) {
  BrowserWindowInterface* browser = anchor ? FindWindow(anchor) : nullptr;
  if (!browser) {
    return nullptr;
  }
  const TabStripModel* model = browser->GetTabStripModel();
  return model ? model->GetActiveWebContents() : nullptr;
}

content::WebContents* ActiveTab() {
  if (GlobalBrowserCollection* browsers =
          GlobalBrowserCollection::GetInstance()) {
    if (BrowserWindowInterface* browser = browsers->GetActiveBrowser()) {
      if (const TabStripModel* model = browser->GetTabStripModel()) {
        if (content::WebContents* tab = model->GetActiveWebContents()) {
          return tab;
        }
      }
    }
  }
  // No window is focused: the last one drawn still has a selected tab, and a
  // background read should use it rather than report nothing.
  const std::vector<BrowserWindowInterface*> windows = Windows();
  if (windows.empty()) {
    return nullptr;
  }
  const TabStripModel* model = windows.back()->GetTabStripModel();
  return model ? model->GetActiveWebContents() : nullptr;
}

}  // namespace hook
