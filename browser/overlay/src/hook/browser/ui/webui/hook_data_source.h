// Hook Browser: one data source setup for both of our pages.
//
// chrome://hook and chrome://hook-panel serve the same resources and need the
// same policy, so the parts that are easy to get subtly different (the resource
// map, the default document, the CSP) live here instead of being written twice.

#ifndef HOOK_BROWSER_UI_WEBUI_HOOK_DATA_SOURCE_H_
#define HOOK_BROWSER_UI_WEBUI_HOOK_DATA_SOURCE_H_

namespace content {
class WebUI;
class WebUIDataSource;
}  // namespace content

namespace hook {

// Creates the data source for `host`, serving the pak's resources with
// `default_resource` as the document, and widens `connect-src` to loopback: the
// dock talks to the running Hook app's channel (`channel.rs`) on 127.0.0.1.
content::WebUIDataSource* AddHookDataSource(content::WebUI* web_ui,
                                            const char* host,
                                            int default_resource);

}  // namespace hook

#endif  // HOOK_BROWSER_UI_WEBUI_HOOK_DATA_SOURCE_H_
