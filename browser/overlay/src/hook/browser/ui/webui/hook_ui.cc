// Hook Browser: chrome://hook.

#include "hook/browser/ui/webui/hook_ui.h"

#include <utility>

#include "base/functional/callback_helpers.h"

#include "chrome/grit/hook_resources.h"
#include "content/public/browser/web_ui.h"
#include "content/public/common/url_constants.h"
#include "hook/browser/ui/webui/hook_data_source.h"
#include "hook/browser/ui/webui/hook_page_handler.h"
#include "hook/common/hook_url_constants.h"

namespace hook {

HookUIConfig::HookUIConfig()
    : DefaultWebUIConfig(content::kChromeUIScheme, kHookHost) {}

HookUI::HookUI(content::WebUI* web_ui) : ui::MojoWebUIController(web_ui) {
  AddHookDataSource(web_ui, kHookHost, IDR_HOOK_HOOK_HTML);
}

WEB_UI_CONTROLLER_TYPE_IMPL(HookUI)

HookUI::~HookUI() = default;

void HookUI::BindInterface(
    mojo::PendingReceiver<mojom::PageHandler> receiver) {
  if (!page_handler_) {
    page_handler_ = std::make_unique<HookPageHandler>(
        web_ui()->GetWebContents(), base::DoNothing(), base::DoNothing());
  }
  page_handler_->Bind(std::move(receiver));
}

}  // namespace hook
