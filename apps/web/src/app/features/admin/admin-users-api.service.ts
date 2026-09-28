import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  AdminUser,
  AdminUserDeleteResponse,
  AdminUserInviteBody,
  AdminUserListResponse,
  AdminUserUpdateBody,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Admin user-management API client (auth/03).
 *
 * Speaks the versioned `/api/v1/admin/users/*` routes. All calls carry
 * `withCredentials: true` so the admin session authenticates cross-origin
 * (same pattern as the other admin API services).
 *
 * The admin area is NOT wired to the mock API — it always talks to the
 * real backend (there is no mock admin session).
 */
@Injectable({ providedIn: 'root' })
export class AdminUsersApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  /**
   * Versioned contract paths (short segments — the no-hardcode tripwire
   * flags string literals >= 50 chars, and these are API contract, not
   * tunables, so they don't belong in app-config.json).
   */
  private static readonly USERS_PATH = '/api/v1/admin/users';
  private static readonly INVITE_SEGMENT = '/invite';
  private static readonly RESEND_SEGMENT = '/resend-invite';

  private get usersBase(): string {
    return this.config.get('api').baseUrl + AdminUsersApiService.USERS_PATH;
  }

  /** URL for a single user resource. */
  private userUrl(id: string): string {
    return this.usersBase + '/' + encodeURIComponent(id);
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** Paginated team-user list, newest first. */
  listUsers(limit = 50, offset = 0): Observable<AdminUserListResponse> {
    const params = new HttpParams()
      .set('limit', String(limit))
      .set('offset', String(offset));
    return this.call(
      this.http.get<AdminUserListResponse>(this.usersBase, {
        params,
        withCredentials: true,
      }),
    );
  }

  /** Invite a user by email (provisions their Entra account + emails the invite). */
  inviteUser(body: AdminUserInviteBody): Observable<{ user: AdminUser; emailSent: boolean }> {
    return this.call(
      this.http.post<{ user: AdminUser; emailSent: boolean }>(
        this.usersBase + AdminUsersApiService.INVITE_SEGMENT,
        body,
        { withCredentials: true },
      ),
    );
  }

  /** Rename, change role, toggle active/disabled, or replace memberships. */
  updateUser(id: string, body: AdminUserUpdateBody): Observable<AdminUser> {
    return this.call(
      this.http.patch<AdminUser>(this.userUrl(id), body, {
        withCredentials: true,
      }),
    );
  }

  /** Hard-delete a user (only allowed while they never accepted their invite). */
  deleteUser(id: string): Observable<AdminUserDeleteResponse> {
    return this.call(
      this.http.delete<AdminUserDeleteResponse>(this.userUrl(id), {
        withCredentials: true,
      }),
    );
  }

  /** Resend the invitation email to a pending user. */
  resendInvite(id: string): Observable<{ user: AdminUser; emailSent: boolean }> {
    return this.call(
      this.http.post<{ user: AdminUser; emailSent: boolean }>(
        this.userUrl(id) + AdminUsersApiService.RESEND_SEGMENT,
        {},
        { withCredentials: true },
      ),
    );
  }
}
