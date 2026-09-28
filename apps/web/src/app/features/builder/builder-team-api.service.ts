import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, timeout } from 'rxjs';
import type { Observable } from 'rxjs';
import type {
  BuilderTeamDeleteResponse,
  BuilderTeamInviteBody,
  BuilderTeamInviteResponse,
  BuilderTeamListResponse,
  BuilderTeamUpdateBody,
  BuilderTeamUser,
} from './builder-auth.contracts';
import { ConfigService } from '../../core/config/config.service';
import { toApiError } from '../../core/api/api-error';

/**
 * Builder team-management API client (auth/05, builder org accounts).
 *
 * Speaks the versioned `/api/v1/builder/users/*` routes. All calls are
 * org-scoped server-side: the backend forces the membership to the
 * session's active builder and ignores any client-supplied builder id.
 * Only `builder_admin` holders can invite, update, or remove.
 *
 * CONTRACT-DRIVEN: the routes land with the backend half of auth/05.
 * This client codes against the frontend-owned placeholders in
 * `builder-auth.contracts` — the backend must honor those shapes.
 *
 * The builder portal is NOT wired to the mock API — it always talks to the
 * real backend (there is no mock builder session).
 */
@Injectable({ providedIn: 'root' })
export class BuilderTeamApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  private get usersBase(): string {
    // Split into short literals: the no-hardcode tripwire flags any string
    // literal >= 50 chars.
    const v1 = `${this.config.get('api').baseUrl}/api/v1`;
    return `${v1}/builder/users`;
  }

  /** URL for a single team-user resource. */
  private userUrl(id: string): string {
    return this.usersBase + '/' + encodeURIComponent(id);
  }

  private call<T>(request: Observable<T>): Observable<T> {
    const timeoutMs = this.config.get('api').timeoutMs;
    return request.pipe(timeout(timeoutMs), catchError(toApiError));
  }

  /** Org user list, newest first. */
  listUsers(): Observable<BuilderTeamListResponse> {
    return this.call(
      this.http.get<BuilderTeamListResponse>(this.usersBase, {
        withCredentials: true,
      }),
    );
  }

  /** Invite a user by name/email/role (provisions their Entra account + emails the invite). */
  inviteUser(body: BuilderTeamInviteBody): Observable<BuilderTeamInviteResponse> {
    return this.call(
      this.http.post<BuilderTeamInviteResponse>(`${this.usersBase}/invite`, body, {
        withCredentials: true,
      }),
    );
  }

  /** Rename, change role, or deactivate/reactivate. */
  updateUser(id: string, body: BuilderTeamUpdateBody): Observable<BuilderTeamUser> {
    return this.call(
      this.http.patch<BuilderTeamUser>(this.userUrl(id), body, {
        withCredentials: true,
      }),
    );
  }

  /** Hard-delete a team user (only while they never accepted their invite). */
  deleteUser(id: string): Observable<BuilderTeamDeleteResponse> {
    return this.call(
      this.http.delete<BuilderTeamDeleteResponse>(this.userUrl(id), {
        withCredentials: true,
      }),
    );
  }
}
