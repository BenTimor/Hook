// Hook Browser: one data source setup for both of our pages.

#include "hook/browser/ui/webui/hook_data_source.h"

#include "chrome/browser/profiles/profile.h"
#include "chrome/grit/hook_resources.h"
#include "chrome/grit/hook_resources_map.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "services/network/public/mojom/content_security_policy.mojom.h"
#include "ui/webui/webui_util.h"

namespace hook {

content::WebUIDataSource* AddHookDataSource(content::WebUI* web_ui,
                                            const char* host,
                                            int default_resource) {
  content::WebUIDataSource* source =
      content::WebUIDataSource::CreateAndAdd(Profile::FromWebUI(web_ui), host);
  webui::SetupWebUIDataSource(source, kHookResources, default_resource);

  // The dock's transport is the running Hook app's loopback channel. Loopback
  // is a potentially trustworthy origin, so a chrome:// page may reach it, but
  // only if the policy says which port range; everything the default policy
  // allows is kept.
  source->OverrideContentSecurityPolicy(
      network::mojom::CSPDirectiveName::ConnectSrc,
      "connect-src http://127.0.0.1:* chrome://resources chrome://theme 'self';");
  return source;
}

}  // namespace hook
