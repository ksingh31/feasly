/**
 * @shared/ui barrel — portal UI kit components (docs/design/portal-ui-kit.md §3).
 *
 * Import from '@app/shared/ui' in builder/admin features. Kept separate from
 * the '@app/shared' barrel so the consumer entry chunk doesn't pull in portal
 * components (Lighthouse resource-summary budget).
 */
export { UiButtonComponent } from './button/button.component';
export type { UiButtonSize, UiButtonVariant } from './button/button.component';
export { UiFieldBase } from './fields/field-base';
export { UiFieldShellComponent } from './fields/field-shell.component';
export { UiTextFieldComponent } from './fields/text-field.component';
export type { UiTextFieldType } from './fields/text-field.component';
export { UiSelectComponent } from './fields/select.component';
export type { UiSelectOption } from './fields/select.component';
export { UiMoneyFieldComponent } from './fields/money-field.component';
export { UiDateFieldComponent } from './fields/date-field.component';
export * from './status';
export * from './format';
export * from './timeline';
export * from './entity';
export * from './kpi';
export * from './stepper';
export { EmptyStateComponent } from './empty-state';
export type { EmptyStateVariant, UiLink } from './empty-state';
export { ErrorStateComponent } from './error-state';
export type { ErrorStateKind } from './error-state';
export { KeyValueListComponent } from './key-value-list';
export type { KeyValueItem } from './key-value-list';
export { PageHeaderComponent } from './page-header';
export type { Breadcrumb } from './page-header';
export { PageLayoutComponent } from './page-layout';
export type { PageLayoutPortal } from './page-layout';
export { SkeletonComponent } from './skeleton';
export type { SkeletonVariant } from './skeleton';
