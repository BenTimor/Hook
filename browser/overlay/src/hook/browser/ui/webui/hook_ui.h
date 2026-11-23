// Hook Browser: chrome://hook.
//
// Step 1 of docs/browser-poc-plan.md. The page is ours; it is served from the
// generated hook_resources.pak and drawn by hook/resources/. It carries the
// mojom probe — the live tab list — and, at 380px beside it, the chat dock from
// packages/chat (Step 2).
//
// Step 2's remaining surfaces replace the page's body with the real sign-in card
// and the New Tab page; the seam itself, this controller included, stays.

#ifndef HOOK_BROWSER_UI_WEBUI_HOOK_UI_H_
#define HOOK_BROWSER_UI_WEBUI_HOOK_UI_H_

#include <memory>

#include "content/public/browser/webui_config.h"
#include "hook/common/hook.mojom.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "ui/webui/mojo_web_ui_controller.h"

namespace hook {

class HookPageHandler;
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

  // Bound from the page. The binder is registered in
  // chrome/browser/chrome_browser_interface_binders_webui.cc (browser/patches/),
  // which is the one line that lets chrome://hook ask the browser anything.
  void BindInterface(mojo::PendingReceiver<mojom::PageHandler> receiver);

 private:
  std::unique_ptr<HookPageHandler> page_handler_;

  WEB_UI_CONTROLLER_TYPE_DECL();
};

}  // namespace hook

#endif  // HOOK_BROWSER_UI_WEBUI_HOOK_UI_H_
