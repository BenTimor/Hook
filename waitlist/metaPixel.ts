// Meta (Facebook) Pixel for the public waitlist site.
//
// The base code lives in this module rather than an inline <script> so the site
// keeps a strict Content-Security-Policy without 'unsafe-inline'. Only production
// builds contact Meta, so `pnpm waitlist:dev` never pollutes the live pixel.

const PIXEL_ID = "1156718026779225";

type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  push: Fbq;
  loaded: boolean;
  version: string;
};

const enabled = import.meta.env.PROD;
let fbq: Fbq | null = null;
let initialized = false;

function install(): Fbq | null {
  if (!enabled) return null;
  if (fbq) return fbq;

  const host = window as unknown as { fbq?: Fbq; _fbq?: Fbq };
  if (host.fbq) {
    fbq = host.fbq;
    return fbq;
  }

  // Official Meta bootstrap: calls queue until fbevents.js replaces callMethod.
  const instance = ((...args: unknown[]) => {
    if (instance.callMethod) instance.callMethod(...args);
    else instance.queue.push(args);
  }) as Fbq;
  instance.queue = [];
  instance.push = instance;
  instance.loaded = true;
  instance.version = "2.0";
  host.fbq = instance;
  host._fbq ??= instance;

  const script = document.createElement("script");
  script.async = true;
  script.src = "https://connect.facebook.net/en_US/fbevents.js";
  document.head.appendChild(script);

  fbq = instance;
  return fbq;
}

/** Load the pixel and send the automatic PageView for this visit. */
export function initMetaPixel() {
  if (initialized) return;
  const instance = install();
  if (!instance) return;
  initialized = true;
  instance("init", PIXEL_ID);
  instance("track", "PageView");
}

/**
 * The API redirects a brand-new signup to `/?signup=authenticated&lead=1`.
 * Fire the standard Lead event once, then drop the flag so a reload or a
 * back-navigation cannot count the same signup twice. Returning sign-ins never
 * receive the flag and are not counted as leads.
 */
export function trackSignupLead() {
  const url = new URL(location.href);
  if (url.searchParams.get("lead") !== "1") return;
  url.searchParams.delete("lead");
  history.replaceState(history.state, "", url);
  if (!enabled) return;
  initMetaPixel();
  fbq?.("track", "Lead");
}
