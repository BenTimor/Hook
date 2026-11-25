// Hook Browser: chrome://hook-panel, the dock as a side panel.

#include "hook/browser/ui/webui/hook_panel_ui.h"

#include <utility>

#include "base/functional/bind.h"
#include "chrome/grit/hook_resources.h"
#include "content/public/browser/web_ui.h"
#include "content/public/common/url_constants.h"
#include "hook/browser/ui/webui/hook_data_source.h"
#include "hook/browser/ui/webui/hook_page_handler.h"
#include "hook/common/hook_url_constants.h"

namespace hook {

HookPanelUIConfig::HookPanelUIConfig()
    : DefaultTopChromeWebUIConfig(content::kChromeUIScheme, kHookPanelHost) {}

HookPanelUI::HookPanelUI(content::WebUI* web_ui)
    : TopChromeWebUIController(web_ui) {
  // The same resources as chrome://hook, with the panel's document as the
  // default: one pak, one bundle, two surfaces.
  AddHookDataSource(web_ui, kHookPanelHost, IDR_HOOK_PANEL_HTML);

  page_handler_ = std::make_unique<HookPageHandler>(
      web_ui->GetWebContents(),
      base::BindRepeating(&HookPanelUI::OnPageReady,
                          weak_factory_.GetWeakPtr()),
      base::BindRepeating(&HookPanelUI::OnCloseRequested,
                          weak_factory_.GetWeakPtr()));
}

WEB_UI_CONTROLLER_TYPE_IMPL(HookPanelUI)

HookPanelUI::~HookPanelUI() = default;

void HookPanelUI::BindInterface(
    mojo::PendingReceiver<mojom::PageHandler> receiver) {
  page_handler_->Bind(std::move(receiver));
}

void HookPanelUI::OnPageReady() {
  // `embedder()` is the SidePanelWebUIView that hosts this page; it is what adds
  // the entry to the panel and marks the content available.
  if (base::WeakPtr<Embedder> embedder = this->embedder()) {
    embedder->ShowUI();
  }
}

void HookPanelUI::OnCloseRequested() {
  // The embedder is the SidePanelWebUIView; asking it to close is how a
  // top-chrome page takes itself away (`WebUIContentsWrapper::CloseUI`), and the
  // view's close callback is what actually hides the panel.
  if (base::WeakPtr<Embedder> embedder = this->embedder()) {
    embedder->CloseUI();
  }
}

}  // namespace hook
