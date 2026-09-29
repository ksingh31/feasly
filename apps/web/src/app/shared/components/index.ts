/** @shared/components barrel — import shared UI from here to keep import paths short. */
export { AddressAutocompleteComponent } from './address-autocomplete';
export { BrandMarkComponent } from './brand-mark';
export { BuilderMatchingExplainerComponent } from './builder-matching-explainer';
// PLACEHOLDER (BILL-07) — BILL-06 owns comment-thread; this re-export is
// deleted with the placeholder component when BILL-06 merges.
export { CommentThreadComponent } from './comment-thread';
export type {
  CommentEdit,
  CommentPost,
  CommentThreadConfig,
  ThreadComment,
  ThreadCommentVisibility,
} from './comment-thread';
export { LegalReviewBannerComponent } from './legal-review-banner';
export { PropertyCardComponent } from './property-card';
export { SiteFooterComponent } from './site-footer';
export { SiteNavComponent } from './site-nav';
export { SqftSliderComponent } from './sqft-slider';
export { OptionSelectorComponent } from './option-selector';
export type { OptionCard, TierOption } from './option-selector';
export { WizardBackComponent } from './wizard-back';
export { WizardStepsComponent } from './wizard-steps';
