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
#include "url/gurl.h"

namespace hook {

std::vector<HookTab> ReadTabs(const content::WebContents* web_contents) {
  std::vector<HookTab> rows;
  if (!web_contents) {
    return rows;
  }

  GlobalBrowserCollection* browsers = GlobalBrowserCollection::GetInstance();
  if (!browsers) {
    return rows;
  }

  BrowserWindowInterface* browser = browsers->FindBrowserWithTab(web_contents);
  if (!browser) {
    return rows;
  }

  const TabStripModel* model = browser->GetTabStripModel();
  if (!model) {
    return rows;
  }

  const int active_index = model->active_index();
  rows.reserve(static_cast<size_t>(model->count()));
  for (int i = 0; i < model->count(); ++i) {
    content::WebContents* tab = model->GetWebContentsAt(i);
    if (!tab) {
      continue;
    }

    HookTab row;
    row.index = i;
    // The tab handle is what a later TabContext would key on; it is stable for
    // the life of the tab and never leaves the browser process.
    if (tabs::TabInterface* tab_interface = model->GetTabAtIndex(i)) {
      row.id = tab_interface->GetHandle().raw_value();
    }
    row.active = (i == active_index);
    row.title = base::UTF16ToUTF8(tab->GetTitle());
    row.domain = std::string(tab->GetLastCommittedURL().host());
    rows.push_back(std::move(row));
  }
  return rows;
}

}  // namespace hook
