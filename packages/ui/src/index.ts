// The shared surface of Hook's design system. Every product imports from here
// so the family resemblance is enforced by the build, not by discipline.
export { HookMark } from "./HookMark";
export { WorkspaceMark } from "./WorkspaceMark";
export { WindowControls } from "./WindowControls";
export { isTauri, useWindowState, win } from "./window";
export { Dialog, TextFieldDialog } from "./Dialog";
export { SignInCard } from "./SignInCard";
export type { SignInCardProps, SignInState } from "./SignInCard";
