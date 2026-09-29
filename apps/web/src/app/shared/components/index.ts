/** @shared/components barrel — import shared UI from here to keep import paths short. */
export { AddressAutocompleteComponent } from './address-autocomplete';
export { BrandMarkComponent } from './brand-mark';
export { BuilderMatchingExplainerComponent } from './builder-matching-explainer';
// BILL-06 comment-thread: types are re-exported from the barrel (type-only,
// erased at runtime). Import the CommentThreadComponent VALUE from the
// subpath '../../shared/components/comment-thread' to keep it out of the
// main entry chunk (BILL-06 + BILL-07 load it only via lazy routes).
export type {
  Comment,
  CommentEdit,
  CommentListResponse,
  CommentPost,
  CommentThreadConfig,
  CommentThreadLabels,
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
