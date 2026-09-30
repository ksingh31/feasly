/**
 * AdminLeadCommentsComponent tests (BILL-07).
 *
 * The container is thin: these tests assert it wires the shared
 * `comment-thread` component's outputs to the admin API service with the
 * right visibility values, renders the admin config (toggle + badges),
 * and handles the edit/delete flows. The API service is mocked; the real
 * thread component renders so the surface contract is exercised end to end.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { AdminLeadCommentsComponent } from './admin-lead-comments.component';
import { AdminCommentsApiService } from './admin-comments-api.service';
import type { Comment } from '@feasly/contracts';

const BUILDER_NOTE: Comment = {
  id: 'c-builder',
  entityType: 'lead',
  entityId: 'lead-1',
  authorKind: 'builder',
  authorId: 'builder-user-1',
  authorDisplayName: 'Karan (Elite Craft)',
  visibility: 'org',
  body: 'Met them Saturday.',
  createdAt: '2026-09-29T10:00:00Z',
  updatedAt: '2026-09-29T10:00:00Z',
  edited: false,
  deletedAt: null,
};

const INTERNAL_NOTE: Comment = {
  id: 'c-internal',
  entityType: 'lead',
  entityId: 'lead-1',
  authorKind: 'admin',
  authorId: 'admin@feasly.dev',
  authorDisplayName: 'Priya (platform)',
  visibility: 'admin_only',
  body: 'Watch this one.',
  createdAt: '2026-09-29T11:00:00Z',
  updatedAt: '2026-09-29T11:00:00Z',
  edited: false,
  deletedAt: null,
};

function newComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: 'c-new',
    entityType: 'lead',
    entityId: 'lead-1',
    authorKind: 'admin',
    authorId: 'admin@feasly.dev',
    authorDisplayName: 'Priya (platform)',
    visibility: 'admin_only',
    body: 'New note',
    createdAt: '2026-09-29T12:00:00Z',
    updatedAt: '2026-09-29T12:00:00Z',
    edited: false,
    deletedAt: null,
    ...overrides,
  };
}

describe('AdminLeadCommentsComponent', () => {
  let apiMock: {
    listComments: ReturnType<typeof vi.fn>;
    postComment: ReturnType<typeof vi.fn>;
    editComment: ReturnType<typeof vi.fn>;
    deleteComment: ReturnType<typeof vi.fn>;
  };
  let fixture: ComponentFixture<AdminLeadCommentsComponent>;

  function setup(seed: readonly Comment[] = [BUILDER_NOTE, INTERNAL_NOTE]): void {
    apiMock = {
      listComments: vi.fn(() => of({ comments: seed })),
      postComment: vi.fn((_leadId: string, body: string, visibility: string) =>
        of(newComment({ body, visibility: visibility as 'org' | 'admin_only' })),
      ),
      editComment: vi.fn((id: string, body: string) =>
        of({ ...INTERNAL_NOTE, id, body, edited: true }),
      ),
      deleteComment: vi.fn(() => of(undefined)),
    };
    TestBed.configureTestingModule({
      imports: [AdminLeadCommentsComponent],
      providers: [
        { provide: AdminCommentsApiService, useValue: apiMock },
        { provide: Store, useValue: { selectSnapshot: () => 'admin@feasly.dev' } },
      ],
    });
    fixture = TestBed.createComponent(AdminLeadCommentsComponent);
    fixture.componentRef.setInput('leadId', 'lead-1');
    fixture.detectChanges();
  }

  function textarea(): HTMLTextAreaElement {
    return fixture.nativeElement.querySelector('.comment-thread__composer textarea');
  }

  function setText(el: HTMLTextAreaElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function clickButton(text: string, scope: ParentNode = fixture.nativeElement): void {
    const buttons = [...scope.querySelectorAll('button')];
    const btn = buttons.find((b) => b.textContent?.trim() === text);
    if (!btn) throw new Error(`button "${text}" not found`);
    btn.click();
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('loads and renders every comment, builder notes included', () => {
    setup();
    const items = fixture.nativeElement.querySelectorAll('.comment-thread__item');
    expect(items.length).toBe(2);
    expect(fixture.nativeElement.textContent).toContain('Met them Saturday.');
    expect(fixture.nativeElement.textContent).toContain('Watch this one.');
    expect(apiMock.listComments).toHaveBeenCalledWith('lead-1');
  });

  it('badges internal notes and leaves shared notes unbadged', () => {
    setup();
    const badges = fixture.nativeElement.querySelectorAll('.comment-thread__internal');
    expect(badges.length).toBe(1);
    expect(badges[0].textContent).toContain('Internal');
    // The badge lives on the internal note's item.
    const items = [...fixture.nativeElement.querySelectorAll('.comment-thread__item')];
    const internalItem = items.find((el) =>
      el.textContent?.includes('Watch this one.'),
    );
    expect(internalItem?.querySelector('.comment-thread__internal')).toBeTruthy();
    const sharedItem = items.find((el) =>
      el.textContent?.includes('Met them Saturday.'),
    );
    expect(sharedItem?.querySelector('.comment-thread__internal')).toBeNull();
  });

  it('defaults the composer visibility toggle to Internal only', () => {
    setup();
    const select = fixture.nativeElement.querySelector(
      '.comment-thread__visibility select',
    ) as HTMLSelectElement;
    expect(select.value).toBe('admin_only');
    expect(select.selectedOptions[0].textContent).toContain('Internal only');
  });

  it('posts with admin_only when the default toggle is kept', () => {
    setup();
    setText(textarea(), 'Internal follow-up');
    clickButton('Post');
    expect(apiMock.postComment).toHaveBeenCalledWith('lead-1', 'Internal follow-up', 'admin_only');
    expect(fixture.nativeElement.textContent).toContain('Internal follow-up');
  });

  it('posts with org when the builder-visible option is chosen', () => {
    setup();
    const select = fixture.nativeElement.querySelector(
      '.comment-thread__visibility select',
    ) as HTMLSelectElement;
    select.value = 'org';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    setText(textarea(), 'Shared update');
    clickButton('Post');
    expect(apiMock.postComment).toHaveBeenCalledWith('lead-1', 'Shared update', 'org');
  });

  it('edits the admins own comment through the service and updates the thread', () => {
    setup();
    const items = [...fixture.nativeElement.querySelectorAll('.comment-thread__item')];
    // The builder's note is not editable by the admin (author-only edits);
    // the admin's own internal note is.
    expect(items[0].textContent).not.toContain('Edit');
    const ownItem = items.find((el) =>
      el.textContent?.includes('Watch this one.'),
    ) as HTMLElement;
    clickButton('Edit', ownItem);
    const editArea = fixture.nativeElement.querySelector('.comment-thread__edit textarea');
    setText(editArea, 'Edited note');
    clickButton('Save');
    expect(apiMock.editComment).toHaveBeenCalledWith('c-internal', 'Edited note');
    expect(fixture.nativeElement.textContent).toContain('Edited note');
    expect(fixture.nativeElement.textContent).toContain('Edited');
  });

  it('deletes a comment after confirm and removes it from the thread', () => {
    setup();
    const items = [...fixture.nativeElement.querySelectorAll('.comment-thread__item')];
    const internalItem = items.find((el) =>
      el.textContent?.includes('Watch this one.'),
    ) as HTMLElement;
    clickButton('Delete', internalItem);
    // Confirm step appears; the service is only called on confirm.
    expect(apiMock.deleteComment).not.toHaveBeenCalled();
    clickButton('Confirm delete', internalItem);
    expect(apiMock.deleteComment).toHaveBeenCalledWith('c-internal');
    expect(fixture.nativeElement.textContent).not.toContain('Watch this one.');
  });

  it('shows an inline error when loading fails, with a retry', () => {
    apiMock = {
      listComments: vi.fn(() => throwError(() => new Error('boom'))),
      postComment: vi.fn(),
      editComment: vi.fn(),
      deleteComment: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [AdminLeadCommentsComponent],
      providers: [
        { provide: AdminCommentsApiService, useValue: apiMock },
        { provide: Store, useValue: { selectSnapshot: () => 'admin@feasly.dev' } },
      ],
    });
    fixture = TestBed.createComponent(AdminLeadCommentsComponent);
    fixture.componentRef.setInput('leadId', 'lead-1');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('boom');
    expect(fixture.nativeElement.textContent).toContain('Try again');
  });
});
