import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, Check, CircleCheck, Gauge, MousePointer2, UserRoundPlus } from "lucide-react";
import "@fontsource-variable/inter/wght.css";
import { HookMark } from "../src/components/HookMark";
import { ProductPreview } from "./ProductPreview";
import "./styles.css";

const CTA_COPY = {
  hook: "Hook Me In",
  google: "Join the waitlist with Google",
  early: "Get early access",
  first: "Be first to try Hook",
} as const;

const variant = import.meta.env.VITE_WAITLIST_CTA as keyof typeof CTA_COPY;
const cta = Object.hasOwn(CTA_COPY, variant) ? CTA_COPY[variant] : CTA_COPY.hook;

const BENEFITS = [
  { icon: Gauge, label: "Smarter usage" },
  { icon: MousePointer2, label: "Less effort" },
  { icon: CircleCheck, label: "More done" },
];

const CALLBACK_ERRORS = new Map([
  ["cancelled", "Google sign-in was canceled. You can try again whenever you’re ready."],
  ["expired", "Your sign-in session expired. Please try again."],
  ["unverified", "Please try again with a Google account that has a verified email address."],
  ["failed", "We couldn’t add you to the waitlist. Please try again."],
]);

function Waitlist() {
  const [state, setState] = useState<"checking" | "ready" | "redirecting" | "joined">("checking");
  const [error, setError] = useState(() =>
    CALLBACK_ERRORS.get(new URLSearchParams(window.location.search).get("signup") ?? "") ?? "",
  );

  useEffect(() => {
    let active = true;
    const url = new URL(window.location.href);
    if (url.searchParams.has("signup")) {
      url.searchParams.delete("signup");
      window.history.replaceState(window.history.state, "", url);
    }

    async function checkStatus() {
      try {
        const response = await fetch("/api/waitlist/status", {
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error("Could not load signup status");
        const { joined } = await response.json();
        if (active) setState(joined === true ? "joined" : "ready");
      } catch {
        if (active) setState("ready");
      }
    }

    function restore(event: PageTransitionEvent) {
      if (event.persisted) void checkStatus();
    }

    void checkStatus();
    window.addEventListener("pageshow", restore);
    return () => {
      active = false;
      window.removeEventListener("pageshow", restore);
    };
  }, []);

  async function join() {
    setError("");
    setState("redirecting");
    try {
      const response = await fetch("/api/waitlist/google", {
        method: "POST",
        signal: AbortSignal.timeout(12000),
      });
      if (response.status === 503) {
        setError("Google sign-in is unavailable right now. Please try again later.");
        setState("ready");
        return;
      }
      if (!response.ok) throw new Error("Could not start Google sign-in");
      const { url } = await response.json();
      window.location.assign(url);
    } catch {
      setError("We couldn’t open Google sign-in. Please try again.");
      setState("ready");
    }
  }

  const joined = state === "joined";
  const busy = state === "checking" || state === "redirecting";

  return (
    <div className="site">
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Hook home"><HookMark />Hook</a>
        <span className="availability"><span aria-hidden="true" /> Early access</span>
      </header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            {joined ? (
              <div className="success" role="status">
                <div className="success-icon"><Check size={24} aria-hidden="true" /></div>
                <h1 id="hero-title">Hey — you caught us a little early.</h1>
                <p className="description">Hook isn’t ready just yet, but we’ll send you an email with all the details as soon as the product is ready.</p>
                <p className="thanks">Thanks for joining the waitlist.</p>
              </div>
            ) : (
              <>
                <h1 id="hero-title">You don’t need to understand AI.</h1>
                <p className="subheadline">You just need to use it.</p>
                <p className="description">Hook helps you get more done with AI with less effort and smarter usage.</p>
                <div className="signup">
                  <button type="button" className="join-button" onClick={join} disabled={busy} aria-busy={busy} aria-describedby={cta !== CTA_COPY.google ? "join-description" : undefined}>
                    <span className="join-icon"><UserRoundPlus size={17} strokeWidth={1.8} aria-hidden="true" /></span>
                    <span>{state === "redirecting" ? "Opening Google…" : state === "checking" ? "Checking waitlist…" : cta}</span>
                    {busy ? <span className="spinner" aria-hidden="true" /> : <ArrowRight size={17} strokeWidth={1.75} aria-hidden="true" />}
                  </button>
                  {cta !== CTA_COPY.google && <p className="signup-note" id="join-description">Join the waitlist with Google</p>}
                  {error && <p className="signup-error" role="alert">{error}</p>}
                </div>
              </>
            )}
          </div>
          <ProductPreview />
        </section>

        <ul className="benefits" aria-label="Hook benefits">
          {BENEFITS.map(({ icon: Icon, label }) => (
            <li key={label}><span className="benefit-icon"><Icon size={17} strokeWidth={1.65} aria-hidden="true" /></span>{label}</li>
          ))}
        </ul>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Waitlist /></StrictMode>);
