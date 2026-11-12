import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { motion } from "motion/react";
import { HookMark } from "../src/components/HookMark";
import { FloatingVisualStage } from "./FloatingVisualStage";
import { interests } from "./interests";
import content from "./content.json";

export function InterestsScreen({
  selected,
  onToggle,
  onBack,
  onSkip,
  onNext,
}: {
  selected: string[];
  onToggle: (id: string) => void;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <div className="interest-heading">
        <p className="step-label">A little about you</p>
        <h1 tabIndex={-1}>What would you love to create with Hook?</h1>
        <p className="screen-description">
          Pick anything that interests you. This just helps us get to know you —
          it won’t limit what you can do.
        </p>
      </div>
      <div
        className="interest-options"
        role="group"
        aria-label="Your interests"
      >
        {interests.map(({ id, label, Icon }) => (
          <motion.button
            key={id}
            type="button"
            className="interest-chip"
            aria-pressed={selected.includes(id)}
            onClick={() => onToggle(id)}
            whileTap={{ scale: 0.975 }}
          >
            <Icon size={18} strokeWidth={1.6} aria-hidden="true" />
            <span>{label}</span>
            <span className="interest-check" aria-hidden="true">
              {selected.includes(id) && <Check size={12} strokeWidth={2.4} />}
            </span>
          </motion.button>
        ))}
      </div>
      <FloatingVisualStage selected={selected} />
      <div className="screen-actions interest-actions">
        <button className="text-button" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back
        </button>
        <span className="action-spacer" />
        <button className="text-button" onClick={onSkip}>
          Skip
        </button>
        <button
          className="primary-button"
          disabled={selected.length === 0}
          onClick={onNext}
        >
          Next
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}

function PricingCard({
  plan,
  active,
  featuresPerPage,
  busy,
  saving,
  onChoose,
}: {
  plan: (typeof content.pricing.plans)[number];
  active: boolean;
  featuresPerPage: number;
  busy: boolean;
  saving: boolean;
  onChoose: () => void;
}) {
  const [featurePage, setFeaturePage] = useState(0);
  const pageCount = Math.ceil(plan.features.length / featuresPerPage);
  const page = Math.min(featurePage, pageCount - 1);
  return (
    <article className="pricing-card" data-plan={plan.id} data-active={active}>
      <div className="price-ribbon">
        <span className="price-badge">{content.pricing.badge}</span>
      </div>
      <div className="plan-header">
        <div>
          <h2>{plan.name}</h2>
          <p>{plan.description}</p>
        </div>
      </div>
      <p className="plan-price">
        <del>
          {content.pricing.currency}
          {plan.originalPrice}
        </del>
        <strong>
          {content.pricing.currency}
          {plan.earlyPrice}
        </strong>
        <span>{content.pricing.period}</span>
      </p>
      <p className="plan-includes">{plan.includes}</p>
      <ul className="plan-features">
        {plan.features.map((feature, index) => (
          <li
            key={feature}
            data-visible={Math.floor(index / featuresPerPage) === page}
          >
            <Check size={13} aria-hidden="true" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <div className="feature-pagination">
        <span aria-live="polite">
          Planned features · {page + 1}/{pageCount}
        </span>
        <button
          className="feature-page-button"
          aria-label={`Previous ${plan.name} features`}
          disabled={page === 0}
          onClick={() => setFeaturePage(page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          className="feature-page-button"
          aria-label={`More ${plan.name} features`}
          disabled={page === pageCount - 1}
          onClick={() => setFeaturePage(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <button
        className="plan-choose primary-button"
        onClick={onChoose}
        disabled={busy}
        aria-busy={saving}
      >
        {saving ? "Saving…" : plan.cta}
        <ArrowRight size={16} aria-hidden="true" />
      </button>
    </article>
  );
}

export function PricingScreen({
  preference,
  busy,
  busyPlan,
  error,
  onChoose,
  onBack,
}: {
  preference: string | null;
  busy: boolean;
  busyPlan: string | null;
  error: string;
  onChoose: (plan: string) => void;
  onBack: () => void;
}) {
  const [visiblePlan, setVisiblePlan] = useState(preference ?? "plus");
  const [landscape, setLandscape] = useState(
    () => matchMedia("(max-height: 550px) and (min-width: 500px)").matches,
  );
  useEffect(() => {
    const query = matchMedia("(max-height: 550px) and (min-width: 500px)");
    const update = () => setLandscape(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return (
    <>
      <div className="pricing-heading">
        <p className="step-label">A head start, just for you</p>
        <h1 tabIndex={-1}>Choose how you want to experience Hook.</h1>
        <p className="screen-description">
          Exclusive early-access pricing, just for our first members.
        </p>
      </div>
      <div
        className="mobile-plan-switch"
        role="group"
        aria-label="Preview a plan"
      >
        {content.pricing.plans.map((plan) => (
          <button
            key={plan.id}
            aria-pressed={visiblePlan === plan.id}
            onClick={() => setVisiblePlan(plan.id)}
          >
            {plan.name}
            <span>
              {content.pricing.currency}
              {plan.earlyPrice}
              {content.pricing.period}
            </span>
          </button>
        ))}
      </div>
      <div className="pricing-cards">
        {content.pricing.plans.map((plan) => (
          <PricingCard
            key={plan.id}
            plan={plan}
            active={visiblePlan === plan.id}
            busy={busy}
            saving={busy && busyPlan === plan.id}
            featuresPerPage={landscape ? 2 : 3}
            onChoose={() => onChoose(plan.id)}
          />
        ))}
      </div>
      <div className="pricing-bottom">
        <button className="text-button" onClick={onBack} disabled={busy}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back
        </button>
        <p
          className={error ? "pricing-error" : undefined}
          role={error ? "alert" : undefined}
        >
          {error || content.pricing.disclosure}
        </p>
      </div>
    </>
  );
}

export function ConfirmationScreen({ onHome }: { onHome: () => void }) {
  return (
    <div className="confirmation-panel">
      <motion.div
        className="confirmation-mark"
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 160, damping: 19 }}
      >
        <HookMark />
        <span>
          <Check size={14} aria-hidden="true" />
        </span>
      </motion.div>
      <p className="step-label">You’re on the list</p>
      <h1 tabIndex={-1}>Hey, you caught us a little early.</h1>
      <p className="screen-description">
        Hook isn’t quite ready yet. But you’re on the list, and we’ll email you
        as soon as it’s time to get started.
      </p>
      <p className="thanks">Thanks for being one of the first.</p>
      <button className="text-button" onClick={onHome}>
        <ArrowLeft size={16} aria-hidden="true" />
        Back to Hook
      </button>
    </div>
  );
}
