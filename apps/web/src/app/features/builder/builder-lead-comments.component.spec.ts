/**
 * BuilderLeadCommentsComponent tests (BILL-06).
 *
 * The container is thin: it loads the thread on init and wires the
 * shared thread's outputs to BuilderCommentsApiService. These tests pin
 * that wiring (correct lead id, thread updates on post/edit, error
 * surfacing) against a stubbed API service.
 *
 * Note: async/await with real timers (not fakeAsync) — zone.js is not
 * installed in this repo, so the fakeAsync helper cannot run here.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideStore } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { CommentThreadComponent } from '../../shared/components/comment-thread';
import type { Comment } from '../../shared/components/comment-thread';
import { BUILDER_COPY } from './builder-copy';
import { DEFAULT_BUILDER_COPY } from './builder-copy.defaults';
import { BuilderCommentsApiService } from './builder-comments-api.service';
import { BuilderLeadCommentsComponent } from './builder-lead-comments.component';
import { BuilderState } from './builder.state';

function comment(overrides: Partial<Comment> = {}): Comment {
  const now = new Date().toISOString();
  return {
    id: 'c1',
    entityType: 'lead',
    entityId: 'lead-1',
    authorKind: 'builder',
    authorId: 'builder@example.com',
    authorDisplayName: 'A Builder',
    visibility: 'org',
    body: 'Existing note',
    createdAt: now,
    updatedAt: now,
    edited: false,
    ...overrides,
  };
}

async function setup() {
  const apiStub = {
    listComments: vi.fn((_leadId: string) => of({ comments: [comment()] })),
    postComment: vi.fn((leadId: string, body: string) =>
      of(comment({ id: 'c2', entityId: leadId, body })),
    ),
    editComment: vi.fn((id: string, body: string) =>
      of(comment({ id, body, edited: true })),
    ),
  };
  await TestBed.configureTestingModule({
    imports: [BuilderLeadCommentsComponent],
    providers: [
      provideStore([BuilderState]),
      { provide: BUILDER_COPY, useValue: { ...DEFAULT_BUILDER_COPY } },
      { provide: BuilderCommentsApiService, useValue: apiStub },
    ],
  }).compileComponents();
  const fixture: ComponentFixture<BuilderLeadCommentsComponent> =
    TestBed.createComponent(BuilderLeadCommentsComponent);
  fixture.componentRef.setInput('leadId', 'lead-1');
  fixture.autoDetectChanges();
  await fixture.whenStable();
  return { fixture, apiStub };
}

function threadOf(
  fixture: ComponentFixture<BuilderLeadCommentsComponent>,
): CommentThreadComponent {
  return fixture.debugElement.query(By.directive(CommentThreadComponent))
    .componentInstance as CommentThreadComponent;
}

describe('BuilderLeadCommentsComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('loads the lead thread on init with the builder config', async () => {
    const { fixture, apiStub } = await setup();
    expect(apiStub.listComments).toHaveBeenCalledWith('lead-1');
    const thread = threadOf(fixture);
    expect(thread.comments()).toHaveLength(1);
    expect(thread.config().showVisibilityToggle).toBe(false);
    expect(thread.config().showVisibilityBadges).toBe(false);
    expect(thread.config().allowDelete).toBe(false);
    expect(thread.maxLength()).toBe(DEFAULT_BUILDER_COPY.commentsMaxLength);
  });

  it('posts through the API with the lead id and appends the comment', async () => {
    const { fixture, apiStub } = await setup();
    threadOf(fixture).post.emit({ body: 'A new note', visibility: 'org' });
    fixture.detectChanges();
    expect(apiStub.postComment).toHaveBeenCalledWith('lead-1', 'A new note');
    expect(threadOf(fixture).comments()).toHaveLength(2);
  });

  it('edits through the API and updates the thread in place', async () => {
    const { fixture, apiStub } = await setup();
    threadOf(fixture).edit.emit({ id: 'c1', body: 'Edited note' });
    fixture.detectChanges();
    expect(apiStub.editComment).toHaveBeenCalledWith('c1', 'Edited note');
    const updated = threadOf(fixture).comments()[0];
    expect(updated.body).toBe('Edited note');
    expect(updated.edited).toBe(true);
  });

  it('surfaces API failures with builder copy and clears on dismiss', async () => {
    const { fixture, apiStub } = await setup();
    const { throwError } = await import('rxjs');
    apiStub.postComment.mockImplementationOnce(() => throwError(() => new Error('boom')));

    threadOf(fixture).post.emit({ body: 'Doomed', visibility: 'org' });
    fixture.detectChanges();
    expect(threadOf(fixture).error()).toBe(DEFAULT_BUILDER_COPY.commentsPostFailed);

    threadOf(fixture).dismissError.emit();
    fixture.detectChanges();
    expect(threadOf(fixture).error()).toBeNull();
  });
});
