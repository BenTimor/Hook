import content from "./content.json";
import { developmentPreview } from "./devMode";

export type Screen = "landing" | "interests" | "pricing" | "confirmation";
export interface Preferences {
  interests: string[];
  planPreference: string | null;
}
export interface Profile extends Preferences {
  id: string;
  name: string | null;
  email: string;
  joinedAt: string;
  status: string;
  /** True only while the waiting list entry is approved for app + API access. */
  approved: boolean;
  approvedAt: string | null;
  selectedPrice: {
    amountCents: number;
    currency: string;
    period: string;
  } | null;
  onboardingStep: "interests" | "pricing" | "completed";
  onboardingStartedAt: string | null;
  onboardingUpdatedAt: string | null;
  onboardingCompletedAt: string | null;
}

/**
 * Where an approved account installs Hook: the Microsoft Store listing, not an
 * installer file. `url` is the `ms-windows-store://` deep link that opens the
 * Store app on this PC.
 */
export interface StoreLink {
  productId: string;
  url: string;
}
export interface OnboardingState extends Preferences {
  screen: Screen;
}

const STORAGE_KEY = "hook-onboarding-v1";
const screens: Screen[] = ["landing", "interests", "pricing", "confirmation"];

export function restoreOnboarding(): OnboardingState {
  const empty: OnboardingState = {
    screen: "landing",
    interests: [],
    planPreference: null,
  };
  if (developmentPreview) return empty;
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    if (
      !saved ||
      (!screens.includes(saved.screen) && saved.screen !== "signup") ||
      !Array.isArray(saved.interests)
    )
      return empty;
    const interests = [
      ...new Set<string>(
        saved.interests.filter(
          (id: unknown): id is string =>
            typeof id === "string" &&
            content.interests.some((interest) => interest.id === id),
        ),
      ),
    ];
    const planPreference =
      content.pricing.plans.find((plan) => plan.id === saved.planPreference)
        ?.id ?? null;
    const screen = ["confirmation", "signup"].includes(saved.screen)
      ? "landing"
      : saved.screen;
    return {
      screen,
      interests,
      planPreference,
    };
  } catch {
    return empty;
  }
}

export function rememberOnboarding(state: OnboardingState) {
  if (developmentPreview) return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Authenticated choices are also saved to the server by the progress queue.
  }
}

export const unlimitedUsage =
  import.meta.env.VITE_WAITLIST_UNLIMITED_USAGE === "true";
export const usageBenefit = unlimitedUsage
  ? content.usage.unlimitedBenefit
  : content.usage.defaultBenefit;
export const usageDescription = unlimitedUsage
  ? content.usage.unlimitedDescription
  : content.usage.defaultDescription;
