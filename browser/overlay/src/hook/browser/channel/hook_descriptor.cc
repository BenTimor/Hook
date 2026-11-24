// Hook Browser: the descriptor a running Hook host publishes.

#include "hook/browser/channel/hook_descriptor.h"

#include <optional>

#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/strings/string_number_conversions.h"
#include "base/values.h"
#include "hook/browser/account/hook_paths.h"

namespace hook {

ChannelDescriptor ReadChannelDescriptor() {
  ChannelDescriptor descriptor;
  const base::FilePath path = paths::ChannelDescriptorFile();
  if (path.empty()) {
    descriptor.error = "Hook's data folder is not available on this computer.";
    return descriptor;
  }
  std::string raw;
  if (!base::ReadFileToString(path, &raw)) {
    descriptor.missing = !base::PathExists(path);
    if (!descriptor.missing) {
      descriptor.error = "Hook's channel file cannot be read on this computer.";
    }
    return descriptor;
  }
  std::optional<base::Value> parsed =
      base::JSONReader::Read(raw, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    descriptor.error = "Hook published a channel this browser cannot read.";
    return descriptor;
  }
  const base::DictValue& dict = parsed->GetDict();
  const std::string* token = dict.FindString("token");
  const std::optional<int> port = dict.FindInt("port");
  descriptor.pid = dict.FindInt("pid").value_or(0);
  if (!token || token->empty() || !port.has_value() || *port <= 0) {
    descriptor.error = "Hook published a channel this browser cannot read.";
    return descriptor;
  }
  descriptor.port = base::NumberToString(*port);
  descriptor.token = *token;
  return descriptor;
}

}  // namespace hook
