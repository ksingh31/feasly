import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  OnInit,
  signal,
  untracked,
} from '@angular/core';
import type { DialogRef } from '@angular/cdk/dialog';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { filter } from 'rxjs';
import type {
  AdminUser,
  AdminUserStatus,
  Builder,
} from '@feasly/contracts';
import {
  type UiDrawerRef,
  type UiRowAction,
  UI_DRAWER_URL_PARAM,
  injectDrawerParam,
  UiConfirmService,
  UiDrawerService,
  UiButtonComponent,
  UiModalService,
  UiRowActionsComponent,
} from '@app/shared/ui';
import {
  CloseEditAdminUser,
  CloseInviteAdminUser,
  DeactivateAdminUser,
  DeleteAdminUser,
  DismissAdminUsersNotice,
  LoadAdminUsers,
  OpenEditAdminUser,
  OpenInviteAdminUser,
  ReactivateAdminUser,
  ResendAdminUserInvite,
} from './admin-users.actions';
import { AdminUsersState } from './admin-users.state';
import { AdminAuthState } from './admin-auth.state';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';
import { AdminBuildersState } from './admin-builders.state';
import { LoadBuilders } from './admin-builders.actions';
import {
  ADMIN_BUILDER_ROLE_LABELS,
  ADMIN_STAFF_ROLE_LABELS,
  AdminUserEditDrawerComponent,
  type AdminUserEditDrawerData,
} from './admin-user-edit-drawer.component';
import { AdminUserInviteModalComponent } from './admin-user-invite-modal.component';

/** Row-menu action ids (#542). */
type UserRowAction = 'edit' | 'resend' | 'reactivate' | 'deactivate' | 'delete';

/** Explainer on the disabled Deactivate item for the sole staff admin (auth/07). */
const LAST_ADMIN_DEACTIVATE_HINT = 'Every organization needs at least one active administrator.';

/**
 * Admin user management (auth/03) — the team-user table.
 *
 * Invite by email (provisions their Entra account + emails a branded
 * invite), edit name/role/org memberships, deactivate/reactivate (sessions
 * are revoked immediately server-side), resend invites, and delete users
 * that never accepted their invite. Every mutation is audit-logged
 * server-side; guard failures surface the backend's plain-English message.
 *
 * The protected seed account and the current admin's own row refuse
 * dangerous actions with an explanatory note.
 *
 * Review 2026-11-13 S8 (#542): each row has one ⋮ `RowActions` menu
 * (Edit · Resend invite · Reactivate/Deactivate · Delete); Edit opens a
 * single-form drawer with one Save (`AdminUserEditDrawerComponent`);
 * Deactivate and Delete confirm through the shared ConfirmDialog (Delete
 * is type-the-email-to-confirm).
 *
 * Guarded by `adminGuard`; noindex via the robots guard; lazy-loaded so it
 * stays out of the public initial bundle. All state lives in
 * `AdminUsersState` — the component only dispatches actions and reads
 * signals. Builder org options come from `AdminBuildersState`.
 */
@Component({
  selector: 'app-admin-users',
  standalone: true,
  imports: [UiRowActionsComponent, UiButtonComponent],
  templateUrl: './admin-users.component.html',
  styleUrls: ['./admin-users.component.scss'],
})
export class AdminUsersComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly drawers = inject(UiDrawerService);
  private readonly modals = inject(UiModalService);
  private readonly confirms = inject(UiConfirmService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly users = this.store.selectSignal(AdminUsersState.users);
  protected readonly total = this.store.selectSignal(AdminUsersState.total);
  protected readonly listStatus = this.store.selectSignal(AdminUsersState.listStatus);
  protected readonly listError = this.store.selectSignal(AdminUsersState.listError);
  protected readonly inviteOpen = this.store.selectSignal(AdminUsersState.inviteOpen);
  protected readonly editingId = this.store.selectSignal(AdminUsersState.editingId);
  protected readonly updating = this.store.selectSignal(AdminUsersState.updating);
  protected readonly updateError = this.store.selectSignal(AdminUsersState.updateError);
  /**
   * auth/07: the table row a failed row action targeted — its error
   * surfaces inline on that row, never as a generic banner.
   */
  protected readonly updateErrorUserId = this.store.selectSignal(
    AdminUsersState.updateErrorUserId,
  );
  protected readonly deleting = this.store.selectSignal(AdminUsersState.deleting);

  /** `users:manage` holders only — read-only staff get a read-only table. */
  private readonly manageUsersSignal = adminCan(
    this.store,
    ADMIN_PERMISSIONS.usersManage,
  );
  protected readonly resendingId = this.store.selectSignal(AdminUsersState.resendingId);
  /** Lowercased email the admin session was issued for — marks the self row. */
  protected readonly selfEmail = this.store.selectSignal(AdminAuthState.email);
  protected readonly notice = this.store.selectSignal(AdminUsersState.notice);
  protected readonly builders = this.store.selectSignal(AdminBuildersState.builders);

  /** The ⋮ menu items for each row, keyed by user id (#542). */
  protected readonly rowActions = computed(() => {
    const map = new Map<string, UiRowAction[]>();
    for (const user of this.users()) map.set(user.id, this.actionsFor(user));
    return map;
  });

  private drawerRef: UiDrawerRef<boolean, AdminUserEditDrawerComponent> | null = null;
  /** The open invite modal, if any — driven by `AdminUsersState.inviteOpen`. */
  private inviteRef: DialogRef<void, AdminUserInviteModalComponent> | null = null;

  /** `?open=<id>` — the user whose edit drawer is open (⌘K hits, #538). */
  protected readonly openId = injectDrawerParam();
  /** The first LoadAdminUsers on this page has settled (rows are current). */
  private readonly loaded = signal(false);

  constructor() {
    // ⌘K hits, EntityLinks and Back/Forward drive the edit drawer off the
    // URL once the list is loaded; a param naming an unknown user is dropped.
    effect(() => {
      const id = this.openId();
      const ready = this.loaded() && this.manageUsersSignal();
      untracked(() => this.syncDrawer(id, ready));
    });
    // #548: the invite modal follows `inviteOpen` — opened by the header
    // button, closed by the state on a successful invite.
    effect(() => {
      const open = this.inviteOpen();
      untracked(() => this.syncInvite(open));
    });
  }

  ngOnInit(): void {
    this.store
      .dispatch(new LoadAdminUsers())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.loaded.set(true),
        error: () => this.loaded.set(true),
      });
    this.store.dispatch(new LoadBuilders());
  }

  private syncDrawer(id: string | null, ready: boolean): void {
    if (id === null || !ready || this.drawers.openDrawer?.urlId === id) return;
    const user = this.users().find((u) => u.id === id);
    if (!user) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { [UI_DRAWER_URL_PARAM]: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
      return;
    }
    this.openEdit(user);
  }

  // ------------------------------------------------------------- invite

  protected openInvite(): void {
    this.store.dispatch(new OpenInviteAdminUser());
  }

  private syncInvite(open: boolean): void {
    if (open && !this.inviteRef) {
      const ref = this.modals.open<AdminUserInviteModalComponent, void>(AdminUserInviteModalComponent, {
        size: 'sm',
        injector: this.injector,
      });
      this.inviteRef = ref;
      ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
        if (this.inviteRef !== ref) return;
        this.inviteRef = null;
        // User dismissal (Esc, scrim, Cancel): clear the state flag too.
        if (this.inviteOpen()) this.store.dispatch(new CloseInviteAdminUser());
      });
    } else if (!open && this.inviteRef) {
      const ref = this.inviteRef;
      this.inviteRef = null;
      ref.close();
    }
  }

  // ---------------------------------------------------------- row menu

  protected onRowAction(user: AdminUser, action: string): void {
    switch (action as UserRowAction) {
      case 'edit':
        this.openEdit(user);
        break;
      case 'resend':
        this.store.dispatch(new ResendAdminUserInvite(user.id));
        break;
      case 'reactivate':
        this.store.dispatch(new ReactivateAdminUser(user.id));
        break;
      case 'deactivate':
        this.confirmDeactivate(user);
        break;
      case 'delete':
        this.confirmDelete(user);
        break;
    }
  }

  private actionsFor(user: AdminUser): UiRowAction[] {
    const actions: UiRowAction[] = [];
    if (this.canEdit(user)) {
      actions.push({ id: 'edit', label: 'Edit' });
    }
    if (user.status === 'invited' && this.canEdit(user)) {
      const sending = this.resendingId() === user.id;
      actions.push({
        id: 'resend',
        label: sending ? 'Sending…' : 'Resend invite',
        disabled: sending,
      });
    }
    if (this.canToggleActive(user)) {
      if (user.status === 'disabled') {
        actions.push({ id: 'reactivate', label: 'Reactivate', disabled: this.updating() });
      } else {
        const sole = this.isSoleStaffAdmin(user);
        actions.push({
          id: 'deactivate',
          label: 'Deactivate',
          tone: 'danger',
          disabled: this.updating() || sole,
          hint: sole ? LAST_ADMIN_DEACTIVATE_HINT : undefined,
        });
      }
    }
    if (this.canDelete(user)) {
      actions.push({ id: 'delete', label: 'Delete', tone: 'danger', disabled: this.deleting() });
    }
    return actions;
  }

  // --------------------------------------------------------------- edit

  /** One drawer, one form, one Save (#542). */
  protected openEdit(user: AdminUser): void {
    this.store.dispatch(new OpenEditAdminUser(user.id));
    const ref = this.drawers.open<AdminUserEditDrawerComponent, boolean, AdminUserEditDrawerData>(
      AdminUserEditDrawerComponent,
      {
        data: { userId: user.id, lockStaffRole: this.isSoleStaffAdmin(user) },
        size: 'md',
        urlId: user.id,
        injector: this.injector,
      },
    );
    this.drawerRef = ref;
    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.drawerRef !== ref) return;
      this.drawerRef = null;
      this.store.dispatch(new CloseEditAdminUser());
    });
  }

  // ------------------------------------------------- deactivate / delete

  /**
   * #473 / #542: Deactivate never fires in one click — the shared
   * ConfirmDialog names the user and the consequence (signed out
   * everywhere), with Cancel focused by default.
   */
  private confirmDeactivate(user: AdminUser): void {
    this.confirms
      .confirm({
        title: `Deactivate ${user.name}?`,
        body:
          `${user.name} (${user.email}) will be signed out everywhere immediately ` +
          "and won't be able to sign in until an admin reactivates them.",
        verb: 'Deactivate',
        tone: 'danger',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.store.dispatch(new DeactivateAdminUser(user.id)));
  }

  /** Delete (never-accepted invites only): type the email to confirm. */
  private confirmDelete(user: AdminUser): void {
    this.confirms
      .confirm({
        title: `Delete ${user.email}?`,
        body:
          'They never accepted their invite, so deleting removes the invitation ' +
          "and their sign-in account permanently. This can't be undone.",
        verb: 'Delete',
        tone: 'danger',
        typeToConfirm: user.email,
        typeToConfirmPrompt: 'To confirm, type',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.store.dispatch(new DeleteAdminUser(user.id)));
  }

  protected dismissNotice(): void {
    this.store.dispatch(new DismissAdminUsersNotice());
  }

  protected reload(): void {
    this.store.dispatch(new LoadAdminUsers());
  }

  // -------------------------------------------------------------- labels

  protected roleLabel(user: AdminUser): string {
    if (user.staffRole) {
      return ADMIN_STAFF_ROLE_LABELS[user.staffRole];
    }
    return user.memberships.map((m) => ADMIN_BUILDER_ROLE_LABELS[m.role]).join(', ');
  }

  protected statusLabel(status: AdminUserStatus): string {
    return (
      { active: 'Active', invited: 'Invited', disabled: 'Disabled' } as const
    )[status];
  }

  protected builderName(builderId: string): string {
    const builders: Builder[] = this.builders();
    return (
      builders.find((b) => b.id === builderId)?.displayName ?? '—'
    );
  }

  protected canEdit(user: AdminUser): boolean {
    return this.canManageUsers() && !user.isProtected;
  }

  protected canToggleActive(user: AdminUser): boolean {
    return this.canManageUsers() && !user.isProtected && user.status !== 'invited';
  }

  /** Whether this row is the signed-in admin (self-harm is blocked server-side). */
  protected isSelf(user: AdminUser): boolean {
    const self = this.selfEmail();
    return self !== null && user.email.toLowerCase() === self;
  }

  protected canDelete(user: AdminUser): boolean {
    // Delete is only ever allowed before the invite is accepted.
    return this.canManageUsers() && !user.isProtected && user.status === 'invited';
  }

  /**
   * `users:manage` holders only — read-only staff see the user table
   * without invite/edit/deactivate actions (backend 403s those writes).
   */
  protected canManageUsers(): boolean {
    return this.manageUsersSignal();
  }

  /**
   * auth/07: whether this row is the sole remaining active staff admin
   * (`super_admin`/`admin`) in the loaded list. Their Deactivate menu item
   * and their drawer staff-role select are disabled with an explainer; the
   * backend 409 is the real enforcement. Pending / deactivated users never
   * count. (The list is paginated, so an admin on another page isn't
   * visible here — the 409 still protects them.)
   */
  protected isSoleStaffAdmin(user: AdminUser | null): boolean {
    if (
      !user ||
      (user.staffRole !== 'super_admin' && user.staffRole !== 'admin') ||
      user.status !== 'active'
    ) {
      return false;
    }
    const admins = this.users().filter(
      (u) =>
        (u.staffRole === 'super_admin' || u.staffRole === 'admin') &&
        u.status === 'active',
    );
    return admins.length === 1 && admins[0]!.id === user.id;
  }
}
