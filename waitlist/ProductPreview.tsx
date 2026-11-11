import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowUp, Check, CircleCheck, Pause, Play } from "lucide-react";
import { HookMark } from "../src/components/HookMark";
import { AppResult, StudyResult, VideoResult, WebsiteResult } from "./PreviewResults";
import "./preview.css";

const SCENES = [
  {
    name: "Website",
    prompt: "Build me a website for my business.",
    steps: ["Plan", "Build", "Review"],
    status: "Website ready to review",
    Result: WebsiteResult,
  },
  {
    name: "Study plan",
    prompt: "Create a study plan that adapts to my progress.",
    steps: ["Analyze", "Schedule", "Adapt"],
    status: "Your study plan is ready",
    Result: StudyResult,
  },
  {
    name: "App",
    prompt: "Build an app for my idea.",
    steps: ["Design", "Develop", "Test"],
    status: "App prototype ready",
    Result: AppResult,
  },
  {
    name: "Promo video",
    prompt: "Create a promo video for my app.",
    steps: ["Script", "Animate", "Edit"],
    status: "Video ready to preview",
    Result: VideoResult,
  },
];

function PreviewScene({ scene, onComplete }: { scene: typeof SCENES[number]; onComplete: () => void }) {
  const { Result } = scene;
  return (
    <div className="demo-scene" data-scene={scene.name}>
      <div className="demo-prompt" onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onComplete();
      }}>
        <p>{Array.from(scene.prompt, (letter, index) => (
          <span key={index} style={{ "--type-at": `${Math.round(130 + index * 990 / scene.prompt.length)}ms` } as CSSProperties}>{letter}</span>
        ))}</p>
        <span className="demo-send"><ArrowUp size={16} strokeWidth={1.9} /></span>
      </div>
      <ol className="demo-workflow">
        {scene.steps.map((step, index) => (
          <li key={step}>
            <span className="demo-step-icon">
              <span>{index + 1}</span>
              <Check size={13} strokeWidth={2.1} />
            </span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <div className="demo-result">
        <p className="demo-status"><CircleCheck size={14} strokeWidth={1.9} />{scene.status}</p>
        <Result />
      </div>
    </div>
  );
}

export function ProductPreview() {
  const preview = useRef<HTMLElement>(null);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [inView, setInView] = useState(false);
  const [tabVisible, setTabVisible] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const updateVisibility = () => setTabVisible(document.visibilityState === "visible");
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);

    const observer = new IntersectionObserver(([entry]) => setInView(entry.intersectionRatio >= 0.15), { threshold: 0.15 });
    const element = preview.current;
    if (element) observer.observe(element);

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  const playing = inView && tabVisible && !paused;
  return (
    <figure className="preview" ref={preview} data-playing={playing} aria-labelledby="preview-caption" aria-describedby="preview-summary">
      <div className="preview-field" aria-hidden="true">
        <span className="preview-light" />
        <span className="orbit orbit-outer" />
        <span className="orbit orbit-inner" />
      </div>
      <div className="preview-window" aria-hidden="true">
        <div className="preview-bar">
          <span className="preview-brand"><HookMark /> Hook</span>
          <span className="preview-label">Product demo</span>
        </div>
        <PreviewScene
          key={sceneIndex}
          scene={SCENES[sceneIndex]}
          onComplete={() => setSceneIndex((index) => (index + 1) % SCENES.length)}
        />
      </div>
      <button
        type="button"
        className="preview-toggle"
        aria-label={paused ? "Play product demo" : "Pause product demo"}
        onClick={() => setPaused((value) => !value)}
      >
        {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
      </button>
      <figcaption>
        <span className="preview-caption" id="preview-caption">A little look at Hook</span>
        <span className="preview-summary" id="preview-summary">Hook turns a single request into a series of steps and a finished result. Examples include building a website, making a study plan, prototyping an app, and creating a promo video.</span>
      </figcaption>
    </figure>
  );
}
