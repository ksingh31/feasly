/**
 * CommentThreadComponent tests (BILL-06).
 *
 * The component is presentational: inputs drive rendering, outputs report
 * intent. These tests pin the thread states, the post/edit flows (own vs
 * others' comments), the pending-op resolution contract with the
 * container, and the config-driven hiding of admin controls.
 *
 * Note: async/await with real timers (not fakeAsync) — zone.js is not
 * installed in this repo, so the fakeAsync helper cannot run here.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { CommentThreadComponent } from './comment-thread.component';
import type {
  Comment,
  CommentEdit,
  CommentPost,
  CommentThreadConfig,
} from './comment-thread.models';
import {
  BUILDER_COMMENT_THREAD_CONFIG,
  DEFAULT_COMMENT_THREAD_LABELS,
  formatCommentTimestamp,
} from './comment-thread.models';

const MAX = 2_000;

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c1',
    entityType: 'lead',
    entityId: 'lead-1',
    authorKind: 'builder',
    authorId: 'user-1',
    authorDisplayName: 'A Builder',
    visibility: 'org',
    body: 'First note',
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    edited: false,
    deletedAt: null,
    ...overrides,
  };
}

async function setup(
  overrides: {
    comments?: readonly Comment[];
    currentUserId?: string;
    config?: CommentThreadConfig;
    loading?: boolean;
    error?: string | null;
  } = {},
): Promise<{
  fixture: ComponentFixture<CommentThreadComponent>;
  component: CommentThreadComponent;
}> {
  await TestBed.configureTestingModule({
    imports: [CommentThreadComponent],
  }).compileComponents();
  const fixture = TestBed.createComponent(CommentThreadComponent);
  const component = fixture.componentInstance;
  fixture.componentRef.setInput('comments', overrides.comments ?? []);
  fixture.componentRef.setInput('currentUserId', overrides.currentUserId ?? 'user-1');
  fixture.componentRef.setInput('config', overrides.config ?? BUILDER_COMMENT_THREAD_CONFIG);
  fixture.componentRef.setInput('maxLength', MAX);
  fixture.componentRef.setInput('loading', overrides.loading ?? false);
  fixture.componentRef.setInput('error', overrides.error ?? null);
  fixture.autoDetectChanges();
  return { fixture, component };
}

function text(fixture: ComponentFixture<CommentThreadComponent>, selector: string): string {
  return fixture.nativeElement.querySelector(selector)?.textContent?.trim() ?? '';
}

describe('CommentThreadComponent', () => {
  beforeEach(async () => {
    TestBed.resetTestingModule();
  });

  it('shows the empty state when there are no comments', async () => {
    const { fixture } = await setup();
    expect(text(fixture, '.comment-thread__status')).toBe(
      DEFAULT_COMMENT_THREAD_LABELS.emptyThread,
    );
    expect(
      fixture.nativeElement.querySelector('.comment-thread__list'),
    ).toBeNull();
  });

  it('shows the loading state instead of the empty state', async () => {
    const { fixture } = await setup({ loading: true });
    expect(text(fixture, '.comment-thread__status')).toBe(
      DEFAULT_COMMENT_THREAD_LABELS.loadingThread,
    );
  });

  it('renders comments with author, relative time, and edited marker', async () => {
    const { fixture } = await setup({
      comments: [
        comment({ id: 'c1', body: 'Hello', edited: false }),
        comment({ id: 'c2', body: 'World', edited: true, authorDisplayName: 'Teammate' }),
      ],
    });
    const items = fixture.nativeElement.querySelectorAll('.comment-thread__item');
    expect(items.length).toBe(2);
    expect(items[0].querySelector('.comment-thread__author').textContent).toContain('A Builder');
    expect(items[0].querySelector('.comment-thread__body').textContent).toContain('Hello');
    expect(items[0].querySelector('.comment-thread__time').textContent).toContain('ago');
    expect(items[1].querySelector('.comment-thread__edited').textContent).toContain(
      DEFAULT_COMMENT_THREAD_LABELS.editedMarker,
    );
  });

  it('posts the trimmed draft and clears it once the container publishes the new thread', async () => {
    const { fixture, component } = await setup();
    const posted: CommentPost[] = [];
    component.post.subscribe((e) => posted.push(e));

    const textarea = fixture.nativeElement.querySelector(
      '.comment-thread__composer textarea',
    ) as HTMLTextAreaElement;
    textarea.value = '  A new note  ';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    (fixture.nativeElement.querySelector(
      '.comment-thread__composer button',
    ) as HTMLButtonElement).click();
    expect(posted).toEqual([{ body: 'A new note', visibility: 'admin_only' }]);
    // Optimistic clear happens only after the container publishes.
    expect(textarea.value).toBe('  A new note  ');

    fixture.componentRef.setInput('comments', [comment({ id: 'c9', body: 'A new note' })]);
    fixture.detectChanges();
    expect(textarea.value).toBe('');
  });

  it('does not post an empty draft', async () => {
    const { fixture, component } = await setup();
    let emitted = 0;
    component.post.subscribe(() => emitted++);
    const button = fixture.nativeElement.querySelector(
      '.comment-thread__composer button',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    button.click();
    expect(emitted).toBe(0);
  });

  it('restores the draft when the container reports a post failure', async () => {
    const { fixture, component } = await setup();
    component.post.subscribe(() => undefined);
    const textarea = fixture.nativeElement.querySelector(
      '.comment-thread__composer textarea',
    ) as HTMLTextAreaElement;
    textarea.value = 'Doomed note';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector(
      '.comment-thread__composer button',
    ) as HTMLButtonElement).click();

    fixture.componentRef.setInput('error', 'Could not post your note.');
    fixture.detectChanges();
    expect(textarea.value).toBe('Doomed note');
    expect(text(fixture, '.comment-thread__error')).toContain('Could not post your note.');
  });

  it('shows the edit affordance only on the current user\'s comments', async () => {
    const { fixture } = await setup({
      currentUserId: 'user-1',
      comments: [
        comment({ id: 'c1', authorId: 'user-1' }),
        comment({ id: 'c2', authorId: 'user-2', authorDisplayName: 'Teammate' }),
      ],
    });
    const items = fixture.nativeElement.querySelectorAll('.comment-thread__item');
    expect(items[0].querySelector('.comment-thread__link')?.textContent).toContain(
      DEFAULT_COMMENT_THREAD_LABELS.editLabel,
    );
    expect(items[1].querySelector('.comment-thread__link')).toBeNull();
  });

  it('never shows edit on someone elses comment, even with the admin config', async () => {
    // The backend 403s edits of other people's comments; the moderator
    // config gates delete only. Emails are compared case-insensitively.
    const { fixture } = await setup({
      currentUserId: 'Owen.Admin@example.com',
      config: {
        allowPost: true,
        allowEdit: true,
        allowDelete: true,
        showVisibilityToggle: true,
        showVisibilityBadges: true,
        showAuthorBadges: false,
      },
      comments: [
        comment({ id: 'c1', authorId: 'owen.admin@example.com', authorKind: 'admin' }),
        comment({ id: 'c2', authorId: 'mya@example.com', authorKind: 'builder' }),
      ],
    });
    const items = fixture.nativeElement.querySelectorAll('.comment-thread__item');
    expect(items[0].querySelector('.comment-thread__link')?.textContent).toContain(
      DEFAULT_COMMENT_THREAD_LABELS.editLabel,
    );
    expect(items[1].querySelector('.comment-thread__link')?.textContent).not.toContain(
      DEFAULT_COMMENT_THREAD_LABELS.editLabel,
    );
    // Delete is still available on both under the admin config.
    expect(fixture.nativeElement.textContent).toContain(
      DEFAULT_COMMENT_THREAD_LABELS.deleteLabel,
    );
  });

  it('edits an own comment and exits edit mode on container publish', async () => {
    const { fixture, component } = await setup({
      comments: [comment({ id: 'c1', body: 'Before', authorId: 'user-1' })],
    });
    const edited: CommentEdit[] = [];
    component.edit.subscribe((e) => edited.push(e));

    (fixture.nativeElement.querySelector('.comment-thread__link') as HTMLButtonElement).click();
    fixture.detectChanges();
    const editArea = fixture.nativeElement.querySelector(
      '.comment-thread__edit textarea',
    ) as HTMLTextAreaElement;
    editArea.value = 'After';
    editArea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector(
      '.comment-thread__edit-actions .comment-thread__btn--primary',
    ) as HTMLButtonElement).click();

    expect(edited).toEqual([{ id: 'c1', body: 'After' }]);
    // Still in edit mode until the container publishes.
    expect(fixture.nativeElement.querySelector('.comment-thread__edit')).not.toBeNull();

    fixture.componentRef.setInput(
      'comments',
      [comment({ id: 'c1', body: 'After', edited: true, authorId: 'user-1' })],
    );
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.comment-thread__edit')).toBeNull();
    expect(text(fixture, '.comment-thread__body')).toBe('After');
  });

  it('hides every admin control under the builder config', async () => {
    const { fixture } = await setup({
      config: BUILDER_COMMENT_THREAD_CONFIG,
      comments: [
        comment({ id: 'c1', visibility: 'admin_only', authorKind: 'admin' }),
      ],
    });
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('.comment-thread__internal')).toBeNull();
    expect(root.querySelector('.comment-thread__visibility')).toBeNull();
    expect(root.textContent).not.toContain(DEFAULT_COMMENT_THREAD_LABELS.deleteLabel);
  });

  it('shows the internal badge and visibility toggle when configured (admin)', async () => {
    const { fixture } = await setup({
      config: {
        allowPost: true,
        allowEdit: true,
        allowDelete: true,
        showVisibilityToggle: true,
        showVisibilityBadges: true,
        showAuthorBadges: false,
      },
      comments: [comment({ id: 'c1', visibility: 'admin_only', authorKind: 'admin' })],
    });
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('.comment-thread__internal')?.textContent).toContain(
      DEFAULT_COMMENT_THREAD_LABELS.internalBadge,
    );
    expect(root.querySelector('.comment-thread__visibility select')).not.toBeNull();
    expect(root.textContent).toContain(DEFAULT_COMMENT_THREAD_LABELS.deleteLabel);
  });

  it('emits delete only after the inline confirm step', async () => {
    const { fixture, component } = await setup({
      config: {
        allowPost: true,
        allowEdit: true,
        allowDelete: true,
        showVisibilityToggle: false,
        showVisibilityBadges: false,
        showAuthorBadges: false,
      },
      comments: [comment({ id: 'c1' })],
    });
    const deleted: string[] = [];
    component.delete.subscribe((id) => deleted.push(id));

    const links = Array.from(
      fixture.nativeElement.querySelectorAll('.comment-thread__link'),
    ) as HTMLButtonElement[];
    links.find((b) => b.textContent?.includes(DEFAULT_COMMENT_THREAD_LABELS.deleteLabel))!.click();
    fixture.detectChanges();
    expect(deleted).toEqual([]);

    (fixture.nativeElement.querySelector(
      '.comment-thread__btn--danger',
    ) as HTMLButtonElement).click();
    expect(deleted).toEqual(['c1']);
  });

  it('shows the Feasly team badge on shared admin notes when configured', async () => {
    const { fixture } = await setup({
      config: BUILDER_COMMENT_THREAD_CONFIG,
      comments: [
        comment({ id: 'c1', authorKind: 'admin', visibility: 'org' }),
        comment({ id: 'c2', authorKind: 'builder', visibility: 'org' }),
      ],
    });
    const root: HTMLElement = fixture.nativeElement;
    const badges = root.querySelectorAll('.comment-thread__team');
    // Only the admin-authored note gets the badge.
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain('Feasly team');
  });

  it('never shows the team badge when showAuthorBadges is off', async () => {
    const { fixture } = await setup({
      config: {
        allowPost: true,
        allowEdit: true,
        allowDelete: false,
        showVisibilityToggle: false,
        showVisibilityBadges: false,
        showAuthorBadges: false,
      },
      comments: [comment({ id: 'c1', authorKind: 'admin', visibility: 'org' })],
    });
    expect(
      fixture.nativeElement.querySelector('.comment-thread__team'),
    ).toBeNull();
  });

  it('hides the thread heading when showHeading is false', async () => {
    const { fixture } = await setup({
      config: { ...BUILDER_COMMENT_THREAD_CONFIG, showHeading: false },
      comments: [comment({ id: 'c1' })],
    });
    expect(
      fixture.nativeElement.querySelector('.comment-thread__heading'),
    ).toBeNull();
  });

  it('renders the thread heading by default', async () => {
    const { fixture } = await setup({
      config: {
        allowPost: true,
        allowEdit: true,
        allowDelete: false,
        showVisibilityToggle: false,
        showVisibilityBadges: false,
        showAuthorBadges: false,
      },
      comments: [comment({ id: 'c1' })],
    });
    const heading = fixture.nativeElement.querySelector(
      '.comment-thread__heading',
    ) as HTMLElement;
    expect(heading).toBeTruthy();
    expect(heading.textContent).toContain(DEFAULT_COMMENT_THREAD_LABELS.heading);
  });
});

describe('formatCommentTimestamp', () => {
  const now = new Date('2026-09-29T12:00:00.000Z');
  const iso = (ms: number): string => new Date(now.getTime() - ms).toISOString();

  it('says "Just now" under a minute', () => {
    expect(formatCommentTimestamp(iso(30_000), now)).toBe('Just now');
  });

  it('uses minutes and hours relatively', () => {
    expect(formatCommentTimestamp(iso(5 * 60_000), now)).toBe('5 min ago');
    expect(formatCommentTimestamp(iso(60_000), now)).toBe('1 min ago');
    expect(formatCommentTimestamp(iso(3 * 3_600_000), now)).toBe('3 hours ago');
    expect(formatCommentTimestamp(iso(3_600_000), now)).toBe('1 hour ago');
  });

  it('uses days relatively, then a calendar date', () => {
    expect(formatCommentTimestamp(iso(86_400_000), now)).toBe('Yesterday');
    expect(formatCommentTimestamp(iso(3 * 86_400_000), now)).toBe('3 days ago');
    expect(formatCommentTimestamp(iso(30 * 86_400_000), now)).toContain('2026');
  });

  it('returns empty for garbage input', () => {
    expect(formatCommentTimestamp('not-a-date', now)).toBe('');
  });
});
