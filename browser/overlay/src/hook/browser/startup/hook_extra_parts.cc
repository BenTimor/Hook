// Hook Browser: the one thing that has to happen at browser startup.

#include "hook/browser/startup/hook_extra_parts.h"

#include <vector>

#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "hook/browser/service/hook_service.h"

namespace hook {

HookExtraParts::HookExtraParts() = default;
HookExtraParts::~HookExtraParts() = default;

void HookExtraParts::PostBrowserStart() {
  if (!g_browser_process) {
    return;
  }
  ProfileManager* manager = g_browser_process->profile_manager();
  if (!manager) {
    return;
  }
  for (Profile* profile : manager->GetLoadedProfiles()) {
    if (profile && profile->IsRegularProfile()) {
      BrowserService::For(profile)->Start();
    }
  }
}

}  // namespace hook
