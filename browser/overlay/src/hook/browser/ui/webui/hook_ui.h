// Hook Browser: chrome://hook.
//
// Step 1 of docs/browser-poc-plan.md. The page is ours; it is served from the
// generated hook_resources.pak and drawn by hook/resources/. It is empty on
// purpose until Step 2 gives it the real surfaces.

#ifndef HOOK_BROWSER_UI_WEBUI_HOOK_UI_H_
#define HOOK_BROWSER_UI_WEBUI_HOOK_UI_H_

#include "content/public/browser/webui_config.h"
#include "ui/webui/mojo_web_ui_controller.h"

namespace hook {

class HookUI;

// Registered in chrome/browser/ui/webui/chrome_web_ui_configs.cc, which is one
// of the patches in browser/patches/. Chromium looks pages up in
// WebUIConfigMap, so this is the whole registration.
class HookUIConfig : public content::DefaultWebUIConfig<HookUI> {
 public:
  HookUIConfig();
};

class HookUI : public ui::MojoWebUIController {
 public:
  explicit HookUI(content::WebUI* web_ui);
  HookUI(const HookUI&) = delete;
  HookUI& operator=(const HookUI&) = delete;
  ~HookUI() override;

 private:
  WEB_UI_CONTROLLER_TYPE_DECL();
};

}  // namespace hook

#endif  // HOOK_BROWSER_UI_WEBUI_HOOK_UI_H_
