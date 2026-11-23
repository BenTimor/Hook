// Hook Browser: chrome://hook.

#include "hook/browser/ui/webui/hook_ui.h"

#include <memory>
#include <utility>
#include <vector>

#include "chrome/browser/profiles/profile.h"
#include "chrome/grit/hook_resources.h"
#include "chrome/grit/hook_resources_map.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/common/url_constants.h"
#include "hook/browser/tabs/hook_tabs.h"
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

void HookUI::BindInterface(
    mojo::PendingReceiver<mojom::PageHandler> receiver) {
  page_handler_.reset();
  page_handler_.Bind(std::move(receiver));
}

void HookUI::GetTabs(GetTabsCallback callback) {
  std::vector<mojom::TabPtr> tabs;
  for (const HookTab& row : ReadTabs(web_ui()->GetWebContents())) {
    mojom::TabPtr tab = mojom::Tab::New();
    tab->index = row.index;
    tab->id = row.id;
    tab->active = row.active;
    tab->title = row.title;
    tab->domain = row.domain;
    tabs.push_back(std::move(tab));
  }
  std::move(callback).Run(std::move(tabs));
}

}  // namespace hook
