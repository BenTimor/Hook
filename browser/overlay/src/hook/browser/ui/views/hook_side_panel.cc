// Hook Browser: the dock as a side panel entry.

#include "hook/browser/ui/views/hook_side_panel.h"

#include <memory>
#include <utility>

#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/weak_ptr.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/side_panel/side_panel_entry.h"
#include "chrome/browser/ui/side_panel/side_panel_enums.h"
#include "chrome/browser/ui/side_panel/side_panel_registry.h"
#include "chrome/browser/ui/side_panel/side_panel_ui.h"
#include "chrome/browser/ui/views/side_panel/side_panel_web_ui_view.h"
#include "chrome/browser/ui/webui/top_chrome/webui_contents_wrapper.h"
#include "chrome/grit/branded_strings.h"
#include "hook/browser/ui/webui/hook_panel_ui.h"
#include "hook/common/hook_url_constants.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/views/view.h"

// Views metadata is per instantiation: the template's type name has to be
// registered or nothing can downcast the panel's view. Reading list does the
// same for its own SidePanelWebUIViewT.
using SidePanelWebUIViewT_HookPanelUI = SidePanelWebUIViewT<hook::HookPanelUI>;
BEGIN_TEMPLATE_METADATA(SidePanelWebUIViewT_HookPanelUI, SidePanelWebUIViewT)
END_METADATA

namespace hook {
namespace {

// Opens the panel at startup. Not the only way in -- the toolbar button is pinned
// by default (toolbar_pref_names.cc) -- but a switch is what a check can assert
// without clicking.
constexpr char kSidePanelSwitch[] = "hook-side-panel";

// The dock draws its own header (conversations, title, close). The side panel's
// header would be a second, empty one above it.
constexpr bool kPanelShowsHeader = false;

// What the panel's own close button reaches: `WebUIContentsWrapper::CloseUI`
// calls the view's close callback, and this is it. Without it the dock's X is a
// button that does nothing.
void CloseHookPanel(base::WeakPtr<BrowserWindowInterface> browser) {
  if (!browser) {
    return;
  }
  if (SidePanelUI* ui = SidePanelUI::From(browser.get())) {
    ui->Close();
  }
}

std::unique_ptr<views::View> CreateHookPanelView(Profile* profile,
                                                 SidePanelEntryScope& scope) {
  return std::make_unique<SidePanelWebUIViewT<HookPanelUI>>(
      scope, base::RepeatingClosure(),
      base::BindRepeating(
          &CloseHookPanel,
          scope.GetBrowserWindowInterface().GetWeakPtr()),
      std::make_unique<WebUIContentsWrapperT<HookPanelUI>>(
          GURL(kHookPanelURL), profile,
          // The task manager's label for this WebUI. The panel's own header is
          // hidden, so this string is the only place a name is needed, and it is
          // only visible in the browser's task manager.
          IDS_PRODUCT_NAME,
          /*esc_closes_ui=*/false));
}

// The window's features are created before its BrowserView, so the side panel
// coordinator that answers SidePanelUI::From() may not exist yet. Try again
// shortly, a bounded number of times, and give up quietly: this is a dev
// switch, not a product flow.
void ShowWhenReady(base::WeakPtr<BrowserWindowInterface> browser,
                   int attempts_left) {
  if (!browser) {
    return;
  }
  if (SidePanelUI* ui = SidePanelUI::From(browser.get())) {
    ui->Show(SidePanelEntry::Id::kHookChat, SidePanelOpenTrigger::kUnknown);
    // Done once the entry's view has a width: showing before the window has laid
    // out leaves the entry marked shown and never sized.
    SidePanelRegistry* registry = SidePanelRegistry::From(browser.get());
    SidePanelEntry* entry =
        registry ? registry->GetEntryForKey(SidePanelEntry::Key(
                       SidePanelEntry::Id::kHookChat))
                 : nullptr;
    views::View* view = entry ? entry->CachedView().get() : nullptr;
    if (view && view->width() > 0) {
      return;
    }
  }
  if (attempts_left <= 0) {
    return;
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE,
      base::BindOnce(&ShowWhenReady, std::move(browser), attempts_left - 1),
      base::Milliseconds(400));
}

}  // namespace

void RegisterHookSidePanel(BrowserWindowInterface* browser, Profile* profile) {
  if (!browser || !profile) {
    return;
  }
  SidePanelRegistry* registry = SidePanelRegistry::From(browser);
  if (!registry) {
    return;
  }

  auto entry = std::make_unique<SidePanelEntry>(
      SidePanelEntry::Key(SidePanelEntry::Id::kHookChat),
      // The profile outlives the browser window, so it outlives this registry.
      base::BindRepeating(&CreateHookPanelView, base::Unretained(profile)),
      /*default_content_width_callback=*/base::NullCallback());
  entry->set_should_show_header(kPanelShowsHeader);
  // A pin button appears in the toolbar while the panel is open, the way every
  // other side panel behaves; pinning it makes the dock always one click away.
  entry->set_should_show_ephemerally_in_toolbar(true);
  registry->Register(std::move(entry));

  if (base::CommandLine::ForCurrentProcess()->HasSwitch(kSidePanelSwitch)) {
    // Posted: the coordinator that answers SidePanelUI::From() is still being
    // constructed while the window's features are.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&ShowWhenReady, browser->GetWeakPtr(), 50));
  }
}

}  // namespace hook
