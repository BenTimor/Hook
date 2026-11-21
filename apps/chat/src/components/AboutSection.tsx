import { ScrollText } from "lucide-react";

import { openExternal } from "../lib/bridge";

/**
 * Where the license lives in the product.
 *
 * Hook is AGPL-3.0-only, so two things have to be reachable from inside a
 * running build rather than only from the repository: the notice that says what
 * the program is, and the terms it is offered under. The AGPL also asks a
 * network-facing build to offer its source, which is what the link is for.
 *
 * The list below is deliberately the *bundled executables* — the only
 * third-party software that is actually redistributed in binary form inside an
 * installer. MinGit is GPL-2.0-only, so its license text has to travel with it;
 * the statically linked crates and npm packages keep their notices in
 * THIRD_PARTY_NOTICES.md, which the last link opens. Keeping this static means
 * the panel cannot break a build, and it stays readable at 380px.
 */

const SOURCE_URL = "https://github.com/BenTimor/Hook";
const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`;
const NOTICES_URL = `${SOURCE_URL}/blob/main/THIRD_PARTY_NOTICES.md`;
const TRADEMARK_URL = `${SOURCE_URL}/blob/main/TRADEMARK.md`;

const BUNDLED = [
  { name: "Git for Windows (MinGit) 2.56.1", license: "GPL-2.0-only" },
  { name: "Node.js 22", license: "MIT" },
  { name: "pi coding agent 1.5.2", license: "MIT" },
];

export function AboutSection({ version }: { version?: string }) {
  return (
    <section className="sheet-section">
      <div className="sheet-label">
        <ScrollText strokeWidth={1.9} style={{ width: 13, height: 13 }} />
        <span>About</span>
      </div>

      <div className="update-settings-copy">
        <strong>Hook {version ?? "…"}</strong>
        <span>
          Free software under the GNU Affero General Public License v3.0.
          Copyright © 2026 Ben Timor.
        </span>
      </div>

      <div className="about-links">
        <button className="btn" onClick={() => void openExternal(SOURCE_URL)}>
          Source code
        </button>
        <button className="btn" onClick={() => void openExternal(LICENSE_URL)}>
          License
        </button>
        <button className="btn" onClick={() => void openExternal(NOTICES_URL)}>
          Third-party notices
        </button>
      </div>

      <p className="sheet-help">
        Hook is offered under the AGPL, which means you may use, study, change
        and share it, and that a modified version offered to others over a
        network must publish its source. It is also available commercially for
        use the AGPL does not permit — see the license.
      </p>

      <p className="sheet-help">
        Bundled programs keep their own licenses:{" "}
        {BUNDLED.map((item, index) => (
          <span key={item.name}>
            {index > 0 ? " · " : null}
            {item.name} ({item.license})
          </span>
        ))}
        . Everything else Hook compiles in is listed in the third-party notices.
      </p>

      <p className="sheet-help">
        The names Hook, Hook Workspace and HookCode, the Hook mark and
        hookcode.io are trademarks and are not covered by the license —{" "}
        <button className="about-inline-link" onClick={() => void openExternal(TRADEMARK_URL)}>
          a fork must rebrand
        </button>
        .
      </p>
    </section>
  );
}
