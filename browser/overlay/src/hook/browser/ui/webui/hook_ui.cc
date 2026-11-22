// Hook Browser: chrome://hook.

#include "hook/browser/ui/webui/hook_ui.h"

#include <memory>

#include "chrome/browser/profiles/profile.h"
#include "chrome/grit/hook_resources.h"
#include "chrome/grit/hook_resources_map.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/common/url_constants.h"
#include "hook/common/hook_url_constants.h"
#include "ui/webui/webui_util.h"

namespace hook {

HookUIConfig::HookUIConfig()
    : DefaultWebUIConfig(content::kChromeUIScheme, kHookHost) {}

HookUI::HookUI(content::WebUI* web_ui) : ui::MojoWebUIController(web_ui) {
  content::WebUIDataSource* source =
      content::WebUIDataSource::CreateAndAdd(Profile::FromWebUI(web_ui),
                                             kHookHost);
  webui::SetupWebUIDataSource(source, kHookResources, IDR_HOOK_HOOK_HTML);
}

WEB_UI_CONTROLLER_TYPE_IMPL(HookUI)

HookUI::~HookUI() = default;

}  // namespace hook
