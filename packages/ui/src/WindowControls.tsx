import { Minus, Square, X } from "lucide-react";

import { win } from "./window";

/**
 * The three window buttons, at the size and weight the whole family uses.
 *
 * Rendered inside a 44px drag strip, next to the pane's own controls. The
 * handlers go through the shared `win` adapter, so a browser build renders them
 * inert instead of crashing.
 */
export function WindowControls() {
  return (
    <div className="window-controls" data-tauri-drag-region={false}>
      <button
        className="wc"
        title="Minimize"
        aria-label="Minimize"
        onClick={() => void win.minimize()}
      >
        <Minus strokeWidth={1.8} />
      </button>
      <button
        className="wc"
        title="Maximize"
        aria-label="Maximize"
        onClick={() => void win.toggleMaximize()}
      >
        <Square strokeWidth={1.7} />
      </button>
      <button
        className="wc"
        data-danger="true"
        title="Close"
        aria-label="Close"
        onClick={() => void win.close()}
      >
        <X strokeWidth={1.8} />
      </button>
    </div>
  );
}
