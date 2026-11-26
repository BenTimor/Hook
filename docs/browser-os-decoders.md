# Hook Browser — decoding with the OS

> **Status: decided, not started — and one build comes first.** Before stage 1,
> build the tree once with `is_component_build = false`
> (`browser/README.md`, "A non-component build"). It has been `true` since the first
> build here, a release configuration links into one image instead of a hundred small
> DLLs, and it will take hours and probably surface something. Doing it *before* the
> codec work keeps the two unknowns apart: if H.264 misbehaves after the switch we
> should not have to ask whether it was the codec or the link.
>
> **Status: decided, not started.** The shipped browser decodes H.264 and AAC
> through Windows' Media Foundation — not through an FFmpeg we ship — and stages 1
> and 2 below are the work that makes that real before a public download. Until
> they land the dev build keeps `proprietary_codecs = true` and
> `ffmpeg_branding = "Chrome"` (`browser/args.gn`), because a browser tested
> against half the web is not a browser; a *release* build must have neither flag,
> or it is the licensed configuration with extra steps (see "The licensing
> position").
>
> Every claim below was read out of the tree at `159.0.8154.13`; line numbers move
> with the tag, so the file and symbol names are the reference.

## The question this answers

A browser needs H.264 and AAC, because that is what nearly every MP4 on the web
is made of. Chromium's default build has neither: the decoders are FFmpeg's, and
FFmpeg's H.264/AAC support is off because the patent pools charge for it. The
measured consequence in our own build:

```
H.264 (avc1 baseline)   canPlayType=""        MSE no
AAC-LC                  canPlayType=""        MSE no
VP9 / VP8 / AV1 / Opus / MP3   probably / yes
```

So: **can Hook Browser decode H.264 and AAC the way Firefox does — by asking the
operating system — instead of shipping decoders and paying the pools?** On Windows
the OS has both (Windows 10/11 include an H.264 decoder and an AAC decoder in
Media Foundation; N editions get them from the free Media Feature Pack).

## What Firefox does

| Surface | Decoder |
| --- | --- |
| `<video>` / MSE on Windows | **Windows' own**, through Media Foundation (since Firefox 20, 2013) |
| … on macOS | **The OS's**, AVFoundation/VideoToolbox |
| … on Linux | **GStreamer plugins from the distribution** (`gst-libav`) |
| … on Android | The platform's `MediaCodec` |
| WebRTC calls (H.264) | **Cisco's OpenH264 binary**, downloaded from Cisco at runtime; Cisco pays the pool for that binary |

The downloaded binary is *not* a playback decoder. Mozilla's own wiki (Media/openh264):

> OpenH264 is for WebRTC only for the time being. Streaming video decode typically
> requires H.264 profiles not included yet in OpenH264 and also audio codecs that
> are not freely available … which means: it doesn't enable playing back MP4
> videos at this time.

Two things follow. First, "install a codec" is not the mechanism — the mechanism is
"the OS already has one, and the browser calls it". Second, the Cisco arrangement
does not help playback: it is scoped to real-time communication and has no AAC.

## How Chromium decides what it can play

Four layers, two of them compile-time.

**1. The codec table is a `#if`.** `media/base/mime_util_internal.cc` builds the
list of playable codecs per container, and H.264 and AAC live inside one
preprocessor block:

```cc
#if BUILDFLAG(USE_PROPRIETARY_CODECS)
  const CodecSet aac{MPEG2_AAC, MPEG4_AAC, MPEG4_XHE_AAC};
  mp4_audio_codecs.insert(aac.begin(), aac.end());
  ...
  mp4_video_codecs.emplace(H264);
  mkv_video_codecs.emplace(H264);
```

This is what `canPlayType` and `MediaSource.isTypeSupported` answer from, and it
is what every site consults before choosing a stream. A codec missing here is
invisible even when a decoder exists.

**2. The flags.** `media/media_options.gni` turns `proprietary_codecs` into
`BUILDFLAG(USE_PROPRIETARY_CODECS)` and gates the platform paths with asserts:

```gn
assert(!enable_platform_hevc || proprietary_codecs,
       "proprietary_codecs required for enable_platform_hevc")
```

`ffmpeg_branding` (`third_party/ffmpeg/ffmpeg_options.gni`) defaults to `Chrome`
only when `is_chrome_branded`; we set it explicitly. The flag also switches on
OpenH264 for WebRTC encoding (`media_options.gni`: `media_use_openh264 = true` … `if
(… || !proprietary_codecs) { media_use_openh264 = false }`).

**3. Software decode is FFmpeg.** `media/filters/ffmpeg_audio_decoder.cc`,
`media/filters/ffmpeg_video_decoder.cc`, driven through `media/ffmpeg/`.
Demuxing also comes from FFmpeg — and demuxing is not the patented part, so an
OS-decoder design keeps FFmpeg for containers and parsers and replaces only the
decode step.

**4. Hardware decode is the GPU process.** `media/gpu/windows/d3d_video_decoder.*`
and `media/gpu/windows/d3d11_*`, chosen in
`media/mojo/services/gpu_mojo_media_client_win.cc`. This path *already* decodes
H.264, VP9 and AV1 on any machine whose GPU supports them — but the table above
never lets it be asked, because `avc1` is not advertised.

**5. The parser and the converter are gated by the same flag.** This is the layer
the four above hide behind, and it is the one that decides whether a platform
decoder ever sees a frame:

- `media/formats/BUILD.gn` compiles `mp4/avc.cc`, `mp4/aac.cc` and the
  Annex-B/AVC converters only `if (proprietary_codecs)`, so a codec-off build
  cannot read an `avc1`/`mp4a` sample entry at all.
- `media/formats/mp4/box_definitions.{h,cc}` guard `AVCDecoderConfigurationRecord`
  and the `AAC` descriptor the same way.
- `media/filters/BUILD.gn` and `media/filters/ffmpeg_demuxer.cc` guard the two
  bitstream converters: MP4's length-prefixed NAL units are turned into Annex B
  for H.264, and AAC frames get an ADTS header, only when FFmpeg's decoders are
  in the build. A platform decoder is fed the same bitstream an FFmpeg decoder
  would have been, so without them it fails on the first frame.
- `media/filters/stream_parser_factory.cc` guards the MSE side: the MP4 stream
  parser's codec list and its `avc1`/`mp4a` matching.

Parsing is not decoding, which is why the fork compiles all of it in every build:
`browser/patches/0025-parsing-is-not-decoding.patch`.

## The runtime seam already exists

Chromium is not purely compile-time: `media/base/supported_types.h` is a runtime
capability API, and the GPU process feeds it what the machine can actually do.

```
GPU process                                   renderer
gpu_mojo_media_client_win.cc                  render_media_client.cc
  GetPlatformSupportedVideoDecoderConfigs() ──► UpdateDefaultDecoderSupportedVideoProfiles()
  GetPlatformSupportedAudioDecoderConfigs() ──► UpdateDefaultDecoderSupportedAudioTypes()
                                                     │
                                        media/base/supported_types.cc
                                                     │
                          content/public/renderer/content_renderer_client.cc
                                                     │
                                       Blink → canPlayType / isTypeSupported
```

`UpdateDefaultDecoderSupportedAudioTypes({})` is even called when the GPU goes
away (`render_media_client.cc`, `SetGpuFeatureInfoInternal`), so the plumbing
degrades correctly. This is the HEVC precedent: `enable_platform_hevc` plus
`platform_has_optional_hevc_decode_support` plus
`kPlatformHEVCDecoderSupport` exist because Chromium needs to answer "this build
supports HEVC, and *this machine* may not have the extension". **That is exactly
the shape this design needs** — the difference is that HEVC's gate sits behind
`proprietary_codecs`, and we would compile the seam unconditionally while keeping
the FFmpeg decoders out.

## What Windows already has

Worth knowing before estimating, because it is more than expected:

| Piece | Where | State |
| --- | --- | --- |
| Media Foundation **audio** decoder | `media/filters/win/media_foundation_audio_decoder.{h,cc}` | exists, in use; wired in `gpu_mojo_media_client_win.cc` |
| … its codec map | `CodecToMFTTypeInfo` in the same file | AC3, EAC3, AC4, and **AAC only when the profile is xHE-AAC and Windows ≥ 11 22H2** |
| Media Foundation **video** decoder | — | **absent**; only the *encoder* exists |
| Media Foundation encoder plumbing | `media/gpu/windows/media_foundation_video_encode_accelerator_win.cc` | MFT enumeration, `DXGIDeviceManager`, `MFT_MESSAGE_SET_D3D_MANAGER` — all reusable |
| Hardware H.264/VP9/AV1 video | `media/gpu/windows/d3d_video_decoder.*` | exists, used |
| MF decoder probing helper | `FindMediaFoundationPackageDecoder()` in `gpu_mojo_media_client_win.cc` | exists, used for AC4/EAC3 |
| Runtime capability report | `media/base/supported_types.*`, `render_media_client.cc` | exists, HEVC-shaped only |

So the audio half is a smaller job than the video half: the MFT machinery, the
COM initialization, the GPU-process sandbox arrangement and the reporting path are
already there, and AAC is a branch in a `switch` plus a wider supported-types list.

### Windows N: the gap this leaves

Media Foundation on Windows **N** (and KN) editions ships **without** the media
codecs: H.264 and AAC only decode there once the separate *Media Feature Pack* is
installed. A release build with `proprietary_codecs = false` therefore plays no MP4
on a stock Windows N machine — no error, just a black box — and it is a coverage
decision, not a bug to find later.

For the current phase this is accepted: a future agreement (a licensed FFmpeg, or a
decoder we are allowed to ship) is what would close it, and Windows N is a small
slice of the Windows install base. What matters now is that the browser *says* so when
it can tell — stage 1's capability report is the place, and a "this copy of Windows
has no media components" hint is cheap once `media/base/supported_types` is honest.
Until then the dev build keeps FFmpeg and nobody sees it.

## The stages

Each stage is independently shippable and independently useful.

### Stage 1 — advertise what the machine already decodes (days)

Compile the runtime report unconditionally (drop the
`PLATFORM_HAS_OPTIONAL_HEVC_DECODE_SUPPORT` guard around
`UpdateDecoderVideoProfilesInternal` in `render_media_client.cc`); have the Windows
client publish the H.264 profiles `D3DVideoDecoder::GetSupportedVideoDecoderConfigs`
already reports; make the H.264 entry in `mime_util_internal.cc` consult
`IsDefaultDecoderSupportedVideoType()` instead of the `#if`; and compile the
parser/converter layer above (`media/formats`, `media/filters`), because without it
the answer is advertised and then no frame is ever decoded.

Outcome: hardware H.264 playback on any machine whose GPU decodes it, with
`proprietary_codecs = false`. No licence question, no new decoder, no new
maintenance beyond the table edit.

Limits: machines without GPU decode (VMs, old or blocklisted hardware) still get a
black box, and **AAC is still missing**, which most sites treat as "cannot play
this file" — they check the full codec string, audio included.

### Stage 2 — AAC through Media Foundation (1–2 weeks)

Widen `MediaFoundationAudioDecoder`'s map so `AudioCodec::kAAC` maps to
`MFAudioFormat_AAC` for every profile, not only xHE-AAC on 22H2+; publish AAC-LC
and HE-AAC in `GetPlatformSupportedAudioDecoderConfigs()` (probe with the existing
`FindMediaFoundationPackageDecoder`-style helper, since Windows' AAC decoder is
in-box rather than a package); advertise `mp4a` in the table when the report says
so.

Outcome: `video/mp4; codecs="avc1.42E01E,mp4a.40.2"` plays on a normal Windows
machine, hardware H.264 plus OS AAC. This is the stage that removes the AAC
royalty from the picture, and AAC is the expensive half.

Details that will bite: `kCodecDelay` / priming samples for gapless and correct
duration, float vs integer output, sample-rate changes mid-stream, seeks in MSE,
and the sandbox/COM initialization rules in the GPU process (the class already
calls `CoInitialize`, see its unit test note).

### Stage 3 — Media Foundation software H.264 (3–6 weeks)

Machines without GPU decode need a software decoder. Either a new
`media::VideoDecoder` over `MFT_MESSAGE_…`/`IMFTransform` (borrow the DXGI and MFT
enumeration code from the MF encoder), or an MF path inside `d3d_video_decoder`.

Outcome: H.264 on every Windows 10/11 machine, N editions excepted. This is the
stage that makes the OS route *complete*, and the one with the least evidence
behind its estimate.

### Stage 4 (optional) — WebRTC H.264

With `proprietary_codecs = false`, OpenH264 is not compiled in, so calls fall back
to VP8/VP9 with peers that accept them and fail against H.264-only endpoints.
Firefox's answer is to download Cisco's binary at runtime, which is a separate
little project (fetch, verify, sandbox, update) and a separate licence story —
Cisco's, not ours.

## What is in the tree now

Four patches, each one small and independently revertable, all applied by
`browser/patches/series`:

| patch | what it changes |
| --- | --- |
| `0022-ask-the-machine-for-h264` | the video capability report is compiled whenever the Mojo video decoder is (`ENABLE_MOJO_VIDEO_DECODER`, not the HEVC flag); the `!USE_PROPRIETARY_CODECS` vetoes in `supported_types.cc` let a proprietary codec through when the platform reports it; the mp4/mkv tables in `mime_util_internal.cc` carry H.264 and AAC in every build |
| `0023-windows-decodes-aac` | `MediaFoundationAudioDecoder` maps `AudioCodec::kAAC` to `MFAudioFormat_AAC` for every profile (xHE-AAC still needs Windows 11 22H2), and `GetPlatformSupportedAudioDecoderConfigs` publishes AAC-LC/HE-AAC whenever Media Foundation starts |
| `0024-describe-an-h264-stream` | `ffmpeg_common.cc` builds an H.264 decoder config in every build — describing a stream is not decoding it |
| `0025-parsing-is-not-decoding` | the MP4 sample-entry parsers, the AVC record, and the Annex-B/ADTS converters compile in every build, and the demuxer converts unconditionally |

Verified on a non-component, `dcheck_always_on=false`, `proprietary_codecs=false`
build (`out/NoComp`, 2026-11-26):

- `canPlayType` answers "probably" for `avc1.42E01E` **and** `mp4a.40.2` — with no
  FFmpeg H.264 or AAC decoder in the binary at all. That is the codec tables, the
  vetoes and the runtime report (layers 1–4) working together.
- A local H.264+AAC MP4 is **demuxed**: `duration 3`, `videoWidth 320`,
  `videoHeight 180` reach the page. That is `0024` + `0025` working; before them the
  element stalled at `readyState 0` with no metadata.
- `MediaSource.isTypeSupported` still answers false for mp4: the MSE stream-parser
  codec list (`stream_parser_factory.cc`) is not in `0025` yet. Sites that require
  MSE for H.264 (rather than progressive playback) therefore see "not supported".
- Decoding itself is **not** working yet. The GPU process picks
  `D3D11VideoDecoder` (`chrome://gpu` reports "Video Decode: Hardware accelerated"),
  and it fails on the first frame: `D3DStatus::6` = `kDecoderFailedDecode`. The next
  step is decoder-side (the sample/sequence-header form a Media Foundation or D3D11
  decoder expects), not another build flag.

So: stage 1's *advertising* half is done and verified; its *decode* half stops at
the decoder, and stage 2's AAC half is wired but has never been exercised, because
the pipeline fails on video first. Testing the audio path alone (an `.m4a`) is the
first thing to do next.

## What this does not solve

- **Widevine.** Encrypted H.264 (Netflix, Disney+, Prime) needs a CDM *and* a
  decoder in the protected path, which in practice means hardware. The CDM
  agreement with Google is a separate negotiation from anything here.
- **HEVC.** Still behind `enable_hevc_parser_and_hw_decoder` and Microsoft's paid
  extension; out of scope.
- **Linux.** No Media Foundation. The equivalent is GStreamer, which Chromium
  removed years ago, or VA-API hardware decode. Linux would be hardware-only at
  best.
- **macOS.** Chromium already has VideoToolbox for hardware decode; only the table
  would need widening — but Hook Browser is Windows-first, so this is a later
  question.
- **AV1, VP9, VP8, Opus, MP3.** Unchanged; they are already open and built in.
- **Site compatibility beyond codecs.** Nothing here changes layout, DRM,
  extensions or the rest of the browser.

## The licensing position

The argument is Mozilla's: the OS holds the decoder licence (Microsoft pays the
pools), and the browser ships a client of the OS decoder, not a decoder. The pool's
licence defines a royalty-bearing product as one that "constitutes or contains an
AVC Decoder"; a browser whose decode step is an OS MFT can be argued not to contain
one. Three honest caveats:

1. It is a position, not a signed permission; it has stood for Firefox since 2013
   without challenge, which is meaningful precedent and nothing more.
2. The line between the two positions is the codec table. Shipping
   `proprietary_codecs = true` *and* the OS path is simply the licensed
   configuration with extra steps; shipping the OS path *without* the FFmpeg
   decoders is the position.
3. Questions for counsel, together with the pool's PC-software rate:
   does the OS route change the obligation? Does the answer differ for AAC, whose
   decoder is in-box in Windows rather than a separately licensed package? What is
   the exposure if the pool disagrees — a licence back-dated to first distribution?

## When it is worth it

The decision is taken on grounds that do not depend on volume: the pools charge
whoever distributes a build containing a decoder, Hook Browser would be paying
that per install, and the OS route is a client of a decoder someone else already
licenses. The table below is the arithmetic that would have mattered had the
choice been "pay or ship a worse browser"; it is kept because it is also the
reason the *stages* are ordered the way they are — stage 2 is the one that removes
the expensive half (AAC), and stage 3 is only worth its size if machines without
GPU decode turn out to be a real share.

| Installs distributed per year | Licence cost (AAC at $0.98, H.264 free to 100k) | This project |
| --- | --- | --- |
| 0 (dev, testers) | $0 | unnecessary |
| 1,000 | ~$1,000 + ~$980 | not worth it (stage 2 alone is 1–2 weeks) |
| 10,000 | ~$10,800 | marginal |
| 100,000 | ~$99,000 | **clearly worth it** |

Add the rebase cost: `media/` changes on every four-week milestone, and this is
the most rebase-prone code in a fork. That is why stages 1–2 are the committed
work item before a public download and stage 3 is conditional: together they cover
any machine with GPU H.264 decode (nearly all of them) plus OS AAC, which is the
combination that makes the common MP4 play.

## How it would be verified

0. Pass `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
   --disable-features=CalculateNativeWinOcclusion` to anything that plays a file: an
   occluded window never starts a media pipeline, and `<video>` sits at
   `readyState 0` with one `stalled` event, which looks exactly like a codec
   failure and is not one.
1. `browser/tools/codecs.html` in a built browser — the matrix this decision was
   made on, and the first thing each stage below should move. It is a plain file,
   no build and no server: `--headless=new --dump-dom` on it prints the table.
   `pnpm browser:smoke --codecs` is the assertion built from it (H.264, AAC, VP9),
   so a build that loses the codecs fails CI-shaped. Before/after tables go in the
   commit that changes them.
2. `chrome://media-internals` on a playing page: the decoder line must name the
   Media Foundation decoder, not `FFmpegVideoDecoder`/`FFmpegAudioDecoder`.
3. `chrome://gpu`: hardware decode status for H.264, and the machine's profile
   list, on a machine with and without a usable GPU.
4. A file matrix, because sites lie: a baseline-profile MP4, a high-profile MP4
   with B-frames, an MP4 with AAC-LC stereo, one with HE-AAC 5.1, a fragmented MP4
   over MSE with a seek, and a long file with a mid-stream sample-rate change.
5. The three sites that matter: X, Vimeo, YouTube (VP9/AV1, must not regress).
6. Windows N and a VM with no GPU: the failure has to be a clean "not supported",
   not a hang.

## Risks

- **MSE timing.** Software MF decode can be slower than FFmpeg and the pipeline's
  buffering assumptions are FFmpeg-tuned; seeks and `SourceBuffer` removal are
  where this shows up.
- **Protected content.** A software decoder in the normal path cannot decrypt
  Widevine; do not promise Netflix.
- **The GPU process.** New MFTs must respect the sandbox and the existing
  `CoInitialize` arrangement; a COM mismatch here is a crash on startup, not a
  video bug.
- **Rebase surface.** Every milestone: `mime_util_internal.cc`,
  `supported_types.cc`, `gpu_mojo_media_client_win.cc`,
  `render_media_client.cc`, plus the decoder files. Small but constant.
- **Windows N / Server.** No Media Foundation decoders until the Media Feature Pack
  is installed (a free Windows component, the user's choice) — a support burden to
  document, not to fix.

## Open questions

- ~~Which stage do we actually need?~~ Stages 1–2 before a public download; stage 3
  if the no-GPU share of real machines justifies it.
- Does the pool accept the OS route for AAC, where the decoder is an in-box Windows
  component rather than a separately licensed package? This is the open legal
  question, and it is the one that matters — AAC is the expensive half.
- ~~Do we keep `proprietary_codecs` in a separate "licensed" build for users who
  want guaranteed playback, or is one build enough?~~ One build, OS decoders. A
  second licensed build doubles what has to be tested and ships a decoder anyway.
- Does anything need this at all before 100k installs?
