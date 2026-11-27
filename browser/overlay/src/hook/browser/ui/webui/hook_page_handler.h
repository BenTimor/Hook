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
#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "hook/browser/channel/hook_channel.h"
#include "hook/common/hook.mojom.h"
#include "mojo/public/cpp/bindings/receiver.h"

namespace content {
class WebContents;
}  // namespace content

namespace hook {

class BrowserService;

// One sign-in lookup in flight; defined by the .cc, which is the only place that
// knows what it carries.
struct SignInLookup;

class HookPageHandler : public mojom::PageHandler {
 public:
  // `on_show_ui` is what the page's ShowUI() call reaches: a no-op in a tab, and
  // "add me to the side panel" in chrome://hook-panel. `on_close_ui` is its
  // opposite, and empty in a tab: the dock's close button has nothing to close
  // there.
  HookPageHandler(content::WebContents* web_contents,
                  base::RepeatingClosure on_show_ui,
                  base::RepeatingClosure on_close_ui);
  HookPageHandler(const HookPageHandler&) = delete;
  HookPageHandler& operator=(const HookPageHandler&) = delete;
  ~HookPageHandler() override;

  // Binds the page's receiver; a page has one handler.
  void Bind(mojo::PendingReceiver<mojom::PageHandler> receiver);

 private:
  // mojom::PageHandler:
  void GetTabs(GetTabsCallback callback) override;
  void ShowUI() override;
  void CloseUI() override;
  void GetChannel(GetChannelCallback callback) override;
  void GetSettings(GetSettingsCallback callback) override;
  void ListChats(ListChatsCallback callback) override;
  void GetChat(const std::string& id, GetChatCallback callback) override;
  void CreateChat(CreateChatCallback callback) override;
  void SendMessage(const std::string& id,
                   const std::string& text,
                   SendMessageCallback callback) override;
  void StopMessage(const std::string& id) override;
  void GetSignIn(GetSignInCallback callback) override;
  void StartSignIn(StartSignInCallback callback) override;
  void CancelSignIn() override;

  // The two halves of GetSignIn: the account file (which is what the gate reads
  // too), then the running app's answer, when there is one.
  void OnSessionKnown(std::shared_ptr<SignInLookup> lookup, bool signed_in);
  void OnChannelChecked(std::shared_ptr<SignInLookup> lookup,
                        bool available,
                        const std::string& reason);
  void OnAuthStatus(std::shared_ptr<SignInLookup> lookup,
                    std::optional<base::DictValue> body,
                    const std::string& error);
  // StartSignIn: the app must answer before the flow can exist.
  void OnStartChannelChecked(StartSignInCallback callback,
                             bool available,
                             const std::string& reason);
  void OnStartReply(StartSignInCallback callback,
                    std::optional<base::DictValue> body,
                    const std::string& error);

  // The channel client, made on first use (it needs the page's profile). It is
  // the profile's, shared with the page-read poller: one descriptor, one token,
  // one reconnect.
  HookChannel* Channel();

  // The WebContents this page belongs to: the tab reader needs it to find the
  // window whose tabstrip the page is describing. Owned by the WebUI, which
  // outlives the handler.
  raw_ptr<content::WebContents> web_contents_;
  base::RepeatingClosure on_show_ui_;
  base::RepeatingClosure on_close_ui_;
  raw_ptr<BrowserService> service_ = nullptr;

  mojo::Receiver<mojom::PageHandler> receiver_{this};

  base::WeakPtrFactory<HookPageHandler> weak_factory_{this};
};

}  // namespace hook

#endif  // HOOK_BROWSER_UI_WEBUI_HOOK_PAGE_HANDLER_H_
