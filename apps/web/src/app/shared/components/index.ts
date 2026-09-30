/** @shared/components barrel — import shared UI from here to keep import paths short. */
export { AddressAutocompleteComponent } from './address-autocomplete';
export { BrandMarkComponent } from './brand-mark';
export { BuilderMatchingExplainerComponent } from './builder-matching-explainer';
// Note (BILL-06): comment-thread's RUNTIME values (CommentThreadComponent,
// BUILDER_COMMENT_THREAD_CONFIG, DEFAULT_COMMENT_THREAD_LABELS,
// formatCommentTimestamp) are intentionally NOT re-exported here. They are
// imported via the direct subpath '../../shared/components/comment-thread'.
// Re-exporting the component from this barrel pulls its 14KB into the main
// entry chunk (it's shared with the lazy builder/admin portals), breaking
// the Lighthouse resource-summary budget. Type-only exports are erased at
// compile time and stay here for convenient typing.
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
