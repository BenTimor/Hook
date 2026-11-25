// Hook Browser: chrome://hook-panel, the dock as a side panel.
//
// Step 2 of docs/browser-poc-plan.md: the side panel is `ChatDock` at the width
// the desktop apps give it. It is a *top chrome* WebUI rather than a plain page
// because that is what `WebUIContentsWrapper` hosts — the browser's own
// surfaces (reading list, bookmarks, history) reach the side panel the same way.
//
// The document is `panel.html` from the same pak as chrome://hook: one React
// bundle, mounted by one page in a tab and another in the panel.

#ifndef HOOK_BROWSER_UI_WEBUI_HOOK_PANEL_UI_H_
#define HOOK_BROWSER_UI_WEBUI_HOOK_PANEL_UI_H_

#include <memory>
#include <string_view>

#include "base/memory/weak_ptr.h"
#include "chrome/browser/ui/webui/top_chrome/top_chrome_web_ui_controller.h"
#include "chrome/browser/ui/webui/top_chrome/top_chrome_webui_config.h"
#include "hook/common/hook.mojom.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"

namespace hook {

class HookPageHandler;
class HookPanelUI;

class HookPanelUIConfig : public DefaultTopChromeWebUIConfig<HookPanelUI> {
 public:
  HookPanelUIConfig();
};

class HookPanelUI : public TopChromeWebUIController {
 public:
  explicit HookPanelUI(content::WebUI* web_ui);
  HookPanelUI(const HookPanelUI&) = delete;
  HookPanelUI& operator=(const HookPanelUI&) = delete;
  ~HookPanelUI() override;

  void BindInterface(mojo::PendingReceiver<mojom::PageHandler> receiver);

  // What TopChromeWebUIConfig and WebUIContentsWrapper ask a top-chrome page
  // for: the name this host appears under in the browser's own surfaces.
  static constexpr std::string_view GetWebUIName() { return "HookPanel"; }

 private:
  // The page says it has drawn; the side panel entry is shown then, not before.
  void OnPageReady();
  // The page's close button: the entry goes away.
  void OnCloseRequested();

  std::unique_ptr<HookPageHandler> page_handler_;
  base::WeakPtrFactory<HookPanelUI> weak_factory_{this};

  WEB_UI_CONTROLLER_TYPE_DECL();
};

}  // namespace hook

#endif  // HOOK_BROWSER_UI_WEBUI_HOOK_PANEL_UI_H_
