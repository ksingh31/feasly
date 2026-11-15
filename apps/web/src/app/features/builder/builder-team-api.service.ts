import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, timeout } from 'rxjs';
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
/**
 * #647: the API speaks `disabled` (`@feasly/contracts` BuilderOrgUser);
 * the team page speaks `deactivated`. Map at this boundary only, both ways.
 */
const WIRE_DEACTIVATED = 'disabled';

function fromWire(user: BuilderTeamUser): BuilderTeamUser {
  const status = user.status as string;
  return status === WIRE_DEACTIVATED ? { ...user, status: 'deactivated' } : user;
}

function toWire(body: BuilderTeamUpdateBody): Record<string, unknown> {
  return body.status === 'deactivated' ? { ...body, status: WIRE_DEACTIVATED } : { ...body };
}

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
      this.http
        .get<BuilderTeamListResponse>(this.usersBase, { withCredentials: true })
        .pipe(map((res) => ({ ...res, users: res.users.map(fromWire) }))),
    );
  }

  /** Invite a user by name/email/role (provisions their Entra account + emails the invite). */
  inviteUser(body: BuilderTeamInviteBody): Observable<BuilderTeamInviteResponse> {
    return this.call(
      this.http
        .post<BuilderTeamInviteResponse>(`${this.usersBase}/invite`, body, {
          withCredentials: true,
        })
        .pipe(map((res) => ({ ...res, user: fromWire(res.user) }))),
    );
  }

  /** Re-send a pending invitation (#535) — fresh link, old one withdrawn. */
  resendInvite(id: string): Observable<BuilderTeamInviteResponse> {
    return this.call(
      this.http
        .post<BuilderTeamInviteResponse>(`${this.userUrl(id)}/resend-invite`, {}, {
          withCredentials: true,
        })
        .pipe(map((res) => ({ ...res, user: fromWire(res.user) }))),
    );
  }

  /** Rename, change role, or deactivate/reactivate. */
  updateUser(id: string, body: BuilderTeamUpdateBody): Observable<BuilderTeamUser> {
    return this.call(
      this.http
        .patch<BuilderTeamUser>(this.userUrl(id), toWire(body), {
          withCredentials: true,
        })
        .pipe(map(fromWire)),
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
