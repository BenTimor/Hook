// Hook Browser: chrome://hook-newtab.
//
// Step 2's second surface. It is a tab page, not top chrome, so it needs no
// mojom: a greeting, three chips and nothing that asks the browser a question.
// The chips are links, which is why the dock's page and the side panel are one
// click away without this page knowing what either is.
//
// The page draws itself from `newtab.*` in the same pak as chrome://hook, on the
// same tokens.

#ifndef HOOK_BROWSER_UI_WEBUI_HOOK_NEWTAB_UI_H_
#define HOOK_BROWSER_UI_WEBUI_HOOK_NEWTAB_UI_H_

#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/webui_config.h"

namespace hook {

class HookNewTabUI;

class HookNewTabUIConfig : public content::DefaultWebUIConfig<HookNewTabUI> {
 public:
  HookNewTabUIConfig();
};

class HookNewTabUI : public content::WebUIController {
 public:
  explicit HookNewTabUI(content::WebUI* web_ui);
  HookNewTabUI(const HookNewTabUI&) = delete;
  HookNewTabUI& operator=(const HookNewTabUI&) = delete;
  ~HookNewTabUI() override;

 private:
  WEB_UI_CONTROLLER_TYPE_DECL();
};

}  // namespace hook

#endif  // HOOK_BROWSER_UI_WEBUI_HOOK_NEWTAB_UI_H_
