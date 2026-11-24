// Hook Browser: chrome://hook-newtab.

#include "hook/browser/ui/webui/hook_newtab_ui.h"

#include "chrome/grit/hook_resources.h"
#include "content/public/browser/web_ui.h"
#include "content/public/common/url_constants.h"
#include "hook/browser/ui/webui/hook_data_source.h"
#include "hook/common/hook_url_constants.h"

namespace hook {

HookNewTabUIConfig::HookNewTabUIConfig()
    : DefaultWebUIConfig(content::kChromeUIScheme, kHookNewTabHost) {}

HookNewTabUI::HookNewTabUI(content::WebUI* web_ui)
    : content::WebUIController(web_ui) {
  AddHookDataSource(web_ui, kHookNewTabHost, IDR_HOOK_NEWTAB_HTML);
}

WEB_UI_CONTROLLER_TYPE_IMPL(HookNewTabUI)

HookNewTabUI::~HookNewTabUI() = default;

}  // namespace hook
