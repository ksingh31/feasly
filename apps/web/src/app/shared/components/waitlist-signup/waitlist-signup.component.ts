import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { BuildingForm, WaitlistRequest, WaitlistTopic } from '@feasly/contracts';
import { API_SERVICE } from '../../../core/api';
import { ConfigService } from '../../../core/config';

/** Which list the form signs people up for. */
export type WaitlistVariant = 'renovation' | 'city' | 'building-form';

type SignupStatus = 'idle' | 'sending' | 'sent' | 'error';

let nextInstanceId = 0;

/**
 * "Tell me when it's ready" email capture (#520, decision D-P4).
 *
 * - `renovation`: one fixed topic — shown on the scope step when the
 *   Renovation card ("Coming soon") is picked, so nobody fills a reno form
 *   that leads nowhere.
 * - `city`: a city choice (Toronto / Vancouver, config-owned) under the
 *   out-of-coverage message. `query` preselects the city the user typed.
 * - `building-form` (#689): interest in a building form the lot's district
 *   typically allows but Feasly does not estimate yet. The signup carries
 *   the form, the district and the community (`buildingForm`, `district`,
 *   `community`); `formName` is the display name for the copy.
 *
 * Deliberately not a `<form>`: it renders inside the landing page's
 * address form, and nested forms are invalid HTML. Enter in the email
 * field submits this capture and never the surrounding form. All copy
 * comes from ConfigService; the only API call is `joinWaitlist`.
 *
 * CASL (owner decision 2026-11-15): a required, unticked consent checkbox
 * (`copy.waitlist.consentLabel`, byte-checked against approved-copy.md);
 * "Privacy Policy" in the label links to the privacy page. Submit stays
 * disabled, and Enter does nothing, until the box is ticked (#740).
 */
@Component({
  selector: 'app-waitlist-signup',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './waitlist-signup.component.html',
  styleUrl: './waitlist-signup.component.scss',
})
export class WaitlistSignupComponent {
  private readonly api = inject(API_SERVICE);
  private readonly destroyRef = inject(DestroyRef);

  readonly variant = input.required<WaitlistVariant>();
  /** Free text (e.g. the typed address) used to preselect a city. */
  readonly query = input<string>('');
  /** #689 (`building-form` variant): the form of interest. */
  readonly buildingForm = input<BuildingForm | null>(null);
  /** #689: display name of the form, for the heading/body copy. */
  readonly formName = input<string>('');
  /** #689: the lot's land-use district code. */
  readonly district = input<string>('');
  /** #689: the lot's community. */
  readonly community = input<string>('');

  readonly copy = inject(ConfigService).get('copy').waitlist;

  private readonly id = nextInstanceId++;
  readonly headingId = `wl-heading-${this.id}`;
  readonly emailId = `wl-email-${this.id}`;
  readonly errorId = `wl-error-${this.id}`;
  readonly noteId = `wl-note-${this.id}`;
  readonly radioName = `wl-city-${this.id}`;
  readonly consentId = `wl-consent-${this.id}`;
  readonly consentHintId = `wl-consent-hint-${this.id}`;

  readonly email = new FormControl('', {
    nonNullable: true,
    // Length is enforced by the API (400 on overflow), same as the report forms.
    validators: [Validators.required, Validators.email],
  });
  /**
   * CASL consent (owner decision 2026-11-15): REQUIRED, unticked by default.
   * The API rejects a signup without it.
   */
  readonly consent = new FormControl(false, {
    nonNullable: true,
    validators: [Validators.requiredTrue],
  });
  /** Live consent state: gates the submit button and Enter (#740). */
  readonly consentGiven = toSignal(this.consent.valueChanges, {
    initialValue: this.consent.value,
  });

  /**
   * The consent label split around the privacy link, so the byte-checked
   * wording renders whole with "Privacy Policy" as a link.
   */
  readonly consentParts = (() => {
    const label = this.copy.consentLabel;
    const link = this.copy.privacyLinkLabel;
    const at = link ? label.indexOf(link) : -1;
    return at === -1
      ? { before: label, link: '', after: '' }
      : { before: label.slice(0, at), link, after: label.slice(at + link.length) };
  })();

  readonly status = signal<SignupStatus>('idle');
  /** Set when a submit was attempted with an invalid email. */
  readonly showInvalid = signal(false);

  /** Heading/body for the active variant. */
  readonly variantCopy = computed(() => {
    const variant = this.variant();
    if (variant === 'renovation') return this.copy.renovation;
    if (variant === 'city') return this.copy.city;
    // #689: fill the form name and district into the config copy.
    // The heading leads with the name as written; mid-sentence it is lower case.
    const fill = (text: string, form: string): string =>
      text.replaceAll('{form}', form).replaceAll('{district}', this.district());
    return {
      heading: fill(this.copy.buildingForm.heading, this.formName()),
      body: fill(this.copy.buildingForm.body, this.formName().toLowerCase()),
    };
  });
  /** City choices (only the `city` variant renders them). */
  readonly cities = this.copy.city.cities;

  /** User's explicit city pick; null until they choose one. */
  private readonly pickedCity = signal<WaitlistTopic | null>(null);

  /** The topic the signup is for. */
  readonly topic = computed<WaitlistTopic>(() => {
    if (this.variant() === 'renovation') return 'renovation';
    if (this.variant() === 'building-form') return 'building-form';
    const picked = this.pickedCity();
    if (picked) return picked;
    const typed = this.query().toLowerCase();
    const match = this.cities.find((c) => typed.includes(c.match));
    return match?.id ?? this.cities[0].id;
  });

  readonly successMessage = computed(() => this.copy.successByTopic[this.topic()]);

  constructor() {
    // A new query (new out-of-coverage address) re-derives the city.
    effect(() => {
      this.query();
      this.pickedCity.set(null);
    });
    // #689: a different form is a different list — reset a finished signup.
    effect(() => {
      this.buildingForm();
      this.status.set('idle');
    });
  }

  /** The signup body; building-form signups add the form, district and community. */
  private request(): WaitlistRequest {
    const base: WaitlistRequest = { email: this.email.value.trim(), topic: this.topic(), consent: true };
    const form = this.buildingForm();
    if (this.variant() !== 'building-form' || form == null) return base;
    const district = this.district().trim();
    const community = this.community().trim();
    return {
      ...base,
      buildingForm: form,
      ...(district ? { district } : {}),
      ...(community ? { community } : {}),
    };
  }

  pickCity(id: WaitlistTopic): void {
    this.pickedCity.set(id);
  }

  /** Enter in the email field: submit here, never the surrounding form. */
  onEmailEnter(event: Event): void {
    event.preventDefault();
    this.submit();
  }

  submit(): void {
    // Submit is disabled until consent is ticked; this also blocks Enter.
    if (this.status() === 'sending' || !this.consent.valid) return;
    const emailOk = this.email.valid;
    this.showInvalid.set(!emailOk);
    if (!emailOk) return;
    this.status.set('sending');
    this.api
      .joinWaitlist(this.request())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.status.set('sent'),
        error: () => this.status.set('error'),
      });
  }
}
