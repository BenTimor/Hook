// Hook Browser: the page handler both chrome://hook and chrome://hook-panel
// answer with.
//
// It is one implementation because the interface is one contract: the seam page
// asks for the tab list, and the dock asks the same page for the chats a running
// Hook app has, and to send one. Splitting it per host would be two answers to
// one question.

#ifndef HOOK_BROWSER_UI_WEBUI_HOOK_PAGE_HANDLER_H_
#define HOOK_BROWSER_UI_WEBUI_HOOK_PAGE_HANDLER_H_

#include <memory>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "hook/browser/channel/hook_channel.h"
#include "hook/common/hook.mojom.h"
#include "mojo/public/cpp/bindings/receiver.h"

namespace content {
class WebContents;
}  // namespace content

namespace hook {

class HookPageHandler : public mojom::PageHandler {
 public:
  // `on_show_ui` is what the page's ShowUI() call reaches: a no-op in a tab, and
  // "add me to the side panel" in chrome://hook-panel.
  HookPageHandler(content::WebContents* web_contents,
                  base::RepeatingClosure on_show_ui);
  HookPageHandler(const HookPageHandler&) = delete;
  HookPageHandler& operator=(const HookPageHandler&) = delete;
  ~HookPageHandler() override;

  // Binds the page's receiver; a page has one handler.
  void Bind(mojo::PendingReceiver<mojom::PageHandler> receiver);

 private:
  // mojom::PageHandler:
  void GetTabs(GetTabsCallback callback) override;
  void ShowUI() override;
  void GetChannel(GetChannelCallback callback) override;
  void ListChats(ListChatsCallback callback) override;
  void GetChat(const std::string& id, GetChatCallback callback) override;
  void CreateChat(CreateChatCallback callback) override;
  void SendMessage(const std::string& id,
                   const std::string& text,
                   const std::string& context,
                   SendMessageCallback callback) override;
  void StopMessage(const std::string& id) override;

  // The channel client, made on first use (it needs the page's profile).
  HookChannel* Channel();

  // The WebContents this page belongs to: the tab reader needs it to find the
  // window whose tabstrip the page is describing. Owned by the WebUI, which
  // outlives the handler.
  raw_ptr<content::WebContents> web_contents_;
  base::RepeatingClosure on_show_ui_;
  std::unique_ptr<HookChannel> channel_;

  mojo::Receiver<mojom::PageHandler> receiver_{this};
};

}  // namespace hook

#endif  // HOOK_BROWSER_UI_WEBUI_HOOK_PAGE_HANDLER_H_
