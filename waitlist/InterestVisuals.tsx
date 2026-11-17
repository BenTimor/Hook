import {
  ArrowRight,
  Check,
  CircleCheck,
  FileText,
  Image,
  Layers,
  MousePointer2,
  Workflow,
} from "lucide-react";
import { HookMark } from "@hook/ui";

export function DesignPreview() {
  return (
    <div className="interest-design visual-canvas">
      <div className="visual-toolbar">
        <span>Canvas 01</span>
        <Image size={12} />
      </div>
      <div className="design-art">
        <i />
        <i />
        <i />
        <span>
          Make
          <br />
          something
          <br />
          <em>yours.</em>
        </span>
      </div>
      <div className="design-swatches">
        <i />
        <i />
        <i />
        <MousePointer2 size={12} />
      </div>
    </div>
  );
}

export function AutomationPreview() {
  return (
    <div className="interest-automation visual-canvas">
      <div className="visual-toolbar">
        <span>A little less busywork</span>
        <Workflow size={12} />
      </div>
      <div className="automation-flow">
        <span>Trigger</span>
        <ArrowRight size={12} />
        <span>Process</span>
        <ArrowRight size={12} />
        <span>
          <Check size={13} />
          Complete
        </span>
      </div>
      <p>
        <CircleCheck size={12} /> All connected.
      </p>
    </div>
  );
}

export function DocumentPreview() {
  return (
    <div className="interest-document visual-canvas">
      <div className="visual-toolbar">
        <span>Research notes</span>
        <FileText size={12} />
      </div>
      <strong>
        From an idea
        <br />
        to a clear direction.
      </strong>
      <p>
        A few good questions.
        <br />A fresh perspective.
      </p>
      <div>
        <span>Sources organized</span>
        <CircleCheck size={12} />
      </div>
    </div>
  );
}

export function ExplorePreview() {
  return (
    <div className="interest-explore visual-canvas">
      <span className="explore-core">
        <HookMark />
      </span>
      <span className="explore-tile">
        <Layers size={15} />
        Make
      </span>
      <span className="explore-tile">
        <FileText size={15} />
        Learn
      </span>
      <span className="explore-tile">
        <Workflow size={15} />
        Connect
      </span>
      <svg viewBox="0 0 220 140">
        <path d="M110 65L40 39M110 65L176 38M110 65L124 113" />
      </svg>
    </div>
  );
}
