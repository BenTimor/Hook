// Hook Browser: the descriptor a running Hook host publishes.

#include "hook/browser/channel/hook_descriptor.h"

#include <optional>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/strings/string_number_conversions.h"
#include "base/values.h"
#include "hook/browser/account/hook_paths.h"

namespace hook {
namespace {

// One file, parsed. Returns false when it is readable but unusable, which is an
// error rather than "try the next product": a corrupt descriptor of our own must
// not send the browser to another product's token.
bool ReadOne(const base::FilePath& path, ChannelDescriptor& descriptor) {
  std::string raw;
  if (!base::ReadFileToString(path, &raw)) {
    descriptor.error = "Hook's channel file cannot be read on this computer.";
    return false;
  }
  std::optional<base::Value> parsed =
      base::JSONReader::Read(raw, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    descriptor.error = "Hook published a channel this browser cannot read.";
    return false;
  }
  const base::DictValue& dict = parsed->GetDict();
  const std::string* token = dict.FindString("token");
  const std::optional<int> port = dict.FindInt("port");
  descriptor.pid = dict.FindInt("pid").value_or(0);
  if (!token || token->empty() || !port.has_value() || *port <= 0) {
    descriptor.error = "Hook published a channel this browser cannot read.";
    return false;
  }
  descriptor.port = base::NumberToString(*port);
  descriptor.token = *token;
  return true;
}

}  // namespace

std::vector<ChannelDescriptor> ReadChannelDescriptors() {
  std::vector<ChannelDescriptor> descriptors;
  const std::vector<base::FilePath> files = paths::ChannelDescriptorFiles();
  if (files.empty()) {
    return descriptors;
  }
  for (const base::FilePath& path : files) {
    if (!base::PathExists(path)) {
      continue;
    }
    ChannelDescriptor descriptor;
    // `ReadOne` fills in the sentence when the file is there and unusable; the
    // entry is kept so the caller can say why nothing answered.
    ReadOne(path, descriptor);
    descriptors.push_back(std::move(descriptor));
  }
  return descriptors;
}

ChannelDescriptor ReadChannelDescriptor() {
  std::vector<ChannelDescriptor> descriptors = ReadChannelDescriptors();
  if (descriptors.empty()) {
    ChannelDescriptor missing;
    missing.missing = true;
    return missing;
  }
  return std::move(descriptors.front());
}

}  // namespace hook
