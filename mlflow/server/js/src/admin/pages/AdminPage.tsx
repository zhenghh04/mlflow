import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  SimpleSelect,
  SimpleSelectOption,
  Spinner,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Tabs,
  Tag,
  Typography,
  UserIcon,
  useDesignSystemTheme,
} from '@databricks/design-system';
import { FormattedMessage } from 'react-intl';
import { ScrollablePageWrapper } from '@mlflow/mlflow/src/common/components/ScrollablePageWrapper';
import { useQueryClient } from '@mlflow/mlflow/src/common/utils/reactQueryHooks';
import { Link, useLocation, useSearchParams } from '../../common/utils/RoutingUtils';
import { useActiveWorkspace } from '../../workspaces/utils/WorkspaceUtils';
import { performLogout } from '../auth-utils';
import { ConfirmationModal } from '../ConfirmationModal';
import AdminRoutes, { AdminRoutePaths } from '../routes';
import { useTableSelection } from '../useTableSelection';
import {
  useCurrentUserAdminWorkspaces,
  useCurrentUserIsAdmin,
  useCurrentUserIsWorkspaceAdmin,
  useCurrentUserQuery,
  useUsersQuery,
  useDeleteUser,
  useRolesQuery,
  useDeleteRole,
  useUpdateAdmin,
  useWithSettingsReturnTo,
  useTeamMembersQuery,
  useAddTeamMember,
  useRemoveTeamMember,
} from '../hooks';
import { isWorkspaceAdminRole } from '../types';
import { CreateUserModal } from '../components/CreateUserModal';
import { CreateRoleModal } from '../components/CreateRoleModal';
import { UserRolesCell } from '../components/UserRolesCell';
import { ProjectPermissionsModal } from '../components/ProjectPermissionsModal';
import {
  useExperimentsQuery,
  useCreateExperiment,
  useDeleteExperiment,
  useRenameExperiment,
  useRegisteredModelsQuery,
  useSetModelVisibility,
} from '../hooks';

const TEAM_ROLES = ['member', 'admin'] as const;

/** Inline sub-section for managing active-team members. */
/**
 * Shows every user in the system and lets system admins promote/demote the
 * global-admin flag (users.is_admin).  Visible only to is_global_admin users.
 */
const GlobalAdminsSection = () => {
  const { theme } = useDesignSystemTheme();
  const { data: usersData, isLoading } = useUsersQuery();
  const { data: currentUserData } = useCurrentUserQuery();
  const updateAdmin = useUpdateAdmin();

  const currentUsername = currentUserData?.user?.username;
  const users = useMemo(() => usersData?.users ?? [], [usersData]);

  const toggleAdmin = async (username: string, makeAdmin: boolean) => {
    await updateAdmin.mutateAsync({ username, is_admin: makeAdmin });
  };

  return (
    <div
      css={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        border: `1px solid ${theme.colors.border}`,
        borderRadius: theme.general.borderRadiusBase,
        backgroundColor: theme.colors.backgroundSecondary,
      }}
    >
      <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm }}>
        <Typography.Title level={4} withoutMargins>
          <FormattedMessage defaultMessage="Global Admins" description="Global admins section title" />
        </Typography.Title>
        <Tag componentId="admin.global_admins.badge" color="indigo">
          <FormattedMessage defaultMessage="Full system control" description="Global admin badge" />
        </Tag>
      </div>
      <Typography.Hint>
        <FormattedMessage
          defaultMessage="Global admins have full control across all teams — they can access any team, manage users, and delete tenants."
          description="Global admins explanation"
        />
      </Typography.Hint>
      {isLoading ? (
        <Spinner size="small" />
      ) : (
        <Table
          scrollable
          noMinHeight
          css={{
            border: `1px solid ${theme.colors.border}`,
            borderRadius: theme.general.borderRadiusBase,
            overflow: 'hidden',
          }}
        >
          <TableRow isHeader>
            <TableHeader componentId="admin.global_admins.username_header" css={{ flex: 2 }}>
              <FormattedMessage defaultMessage="Username" description="Global admins table username header" />
            </TableHeader>
            <TableHeader componentId="admin.global_admins.status_header" css={{ flex: 2 }}>
              <FormattedMessage defaultMessage="Status" description="Global admins table status header" />
            </TableHeader>
            <TableHeader componentId="admin.global_admins.actions_header" css={{ flex: 1 }}>
              <FormattedMessage defaultMessage="Actions" description="Global admins table actions header" />
            </TableHeader>
          </TableRow>
          {users.map((user) => (
            <TableRow key={user.username}>
              <TableCell css={{ flex: 2 }}>
                <Typography.Text>{user.username}</Typography.Text>
              </TableCell>
              <TableCell css={{ flex: 2 }}>
                {user.is_admin ? (
                  <Tag componentId="admin.global_admins.admin_tag" color="indigo">
                    <FormattedMessage defaultMessage="Global Admin" description="Global admin tag" />
                  </Tag>
                ) : (
                  <Typography.Text color="secondary">
                    <FormattedMessage defaultMessage="Regular user" description="Regular user label" />
                  </Typography.Text>
                )}
              </TableCell>
              <TableCell css={{ flex: 1 }}>
                {user.username !== currentUsername && (
                  <Button
                    componentId="admin.global_admins.toggle_button"
                    type={user.is_admin ? 'tertiary' : 'primary'}
                    danger={user.is_admin}
                    size="small"
                    loading={updateAdmin.isLoading}
                    onClick={() => toggleAdmin(user.username, !user.is_admin)}
                  >
                    {user.is_admin ? (
                      <FormattedMessage defaultMessage="Revoke" description="Revoke global admin button" />
                    ) : (
                      <FormattedMessage defaultMessage="Make Global Admin" description="Promote to global admin button" />
                    )}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </div>
  );
};

/** Read the active team slug from the header-forwarding cookie. */
const getActiveCookieTeam = (): string => {
  const raw = document.cookie
    .split('; ')
    .find((r) => r.startsWith('mlflow_active_team='))
    ?.substring('mlflow_active_team='.length) ?? '';
  try { return decodeURIComponent(raw) || 'default'; } catch { return raw || 'default'; }
};

const TeamMembersSection = () => {
  const { theme } = useDesignSystemTheme();
  const { data, isLoading } = useTeamMembersQuery();
  const addMember = useAddTeamMember();
  const removeMember = useRemoveTeamMember();
  const isGlobalAdmin = useCurrentUserIsAdmin();
  const activeTeam = getActiveCookieTeam();

  const [newUsername, setNewUsername] = useState('');
  const [newRole, setNewRole] = useState<string>('member');
  const [addError, setAddError] = useState<string | null>(null);

  const members = data?.members ?? [];

  const handleAdd = async () => {
    setAddError(null);
    if (!newUsername.trim()) {
      setAddError('Username is required');
      return;
    }
    try {
      await addMember.mutateAsync({ username: newUsername.trim(), role: newRole });
      setNewUsername('');
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : 'Failed to add member');
    }
  };

  const handleRemove = async (username: string) => {
    try {
      await removeMember.mutateAsync(username);
    } catch {
      // errors surface as query invalidation – user can retry
    }
  };

  return (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
      <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm }}>
        <Typography.Title level={4} withoutMargins>
          <FormattedMessage defaultMessage="Team Members" description="Team members section title in admin users tab" />
        </Typography.Title>
        <Tag componentId="admin.team_members.active_team_tag" color="default">
          {activeTeam}
        </Tag>
        {isGlobalAdmin && activeTeam === 'default' && (
          <Typography.Hint>
            <FormattedMessage
              defaultMessage="Switch team in the sidebar to manage other teams"
              description="Hint shown to global admin when on default team"
            />
          </Typography.Hint>
        )}
      </div>
      {addError && (
        <Alert
          componentId="admin.team_members.add_error"
          type="error"
          message={addError}
          closable
          onClose={() => setAddError(null)}
        />
      )}
      <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'flex-end' }}>
        <Input
          componentId="admin.team_members.username_input"
          placeholder="Username"
          value={newUsername}
          onChange={(e) => setNewUsername(e.target.value)}
          css={{ flex: 1 }}
        />
        <SimpleSelect
          id="admin-team-members-role"
          componentId="admin.team_members.role_select"
          value={newRole}
          onChange={({ target }) => setNewRole(target.value)}
        >
          {TEAM_ROLES.map((r) => (
            <SimpleSelectOption key={r} value={r}>
              {r}
            </SimpleSelectOption>
          ))}
        </SimpleSelect>
        <Button
          componentId="admin.team_members.add_button"
          type="primary"
          loading={addMember.isLoading}
          onClick={handleAdd}
        >
          <FormattedMessage defaultMessage="Add member" description="Button to add a team member" />
        </Button>
      </div>
      {isLoading ? (
        <Spinner size="small" />
      ) : members.length === 0 ? (
        <Typography.Text color="secondary">
          <FormattedMessage defaultMessage="No members yet." description="Empty team members list" />
        </Typography.Text>
      ) : (
        <Table scrollable noMinHeight css={{ border: `1px solid ${theme.colors.border}`, borderRadius: theme.general.borderRadiusBase, overflow: 'hidden' }}>
          <TableRow isHeader>
            <TableHeader componentId="admin.team_members.username_header" css={{ flex: 2 }}>
              <FormattedMessage defaultMessage="Username" description="Team members table username header" />
            </TableHeader>
            <TableHeader componentId="admin.team_members.role_header" css={{ flex: 1 }}>
              <FormattedMessage defaultMessage="Role" description="Team members table role header" />
            </TableHeader>
            <TableHeader componentId="admin.team_members.actions_header" css={{ flex: 1 }}>
              <FormattedMessage defaultMessage="Actions" description="Team members table actions header" />
            </TableHeader>
          </TableRow>
          {members.map((m) => (
            <TableRow key={m.username}>
              <TableCell css={{ flex: 2 }}>{m.username}</TableCell>
              <TableCell css={{ flex: 1 }}>
                {m.is_admin ? (
                  <Tag componentId="admin.team_members.admin_tag" color="indigo">admin</Tag>
                ) : (
                  <Typography.Text>{m.role}</Typography.Text>
                )}
              </TableCell>
              <TableCell css={{ flex: 1 }}>
                <Button
                  componentId="admin.team_members.remove_button"
                  danger
                  size="small"
                  loading={removeMember.isLoading && removeMember.variables === m.username}
                  onClick={() => handleRemove(m.username)}
                >
                  <FormattedMessage defaultMessage="Remove" description="Remove team member button" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </Table>
      )}
    </div>
  );
};

const UsersTab = () => {
  const { theme } = useDesignSystemTheme();
  const queryClient = useQueryClient();
  const { data: usersData, isLoading, error: queryError } = useUsersQuery();
  const { data: currentUserData } = useCurrentUserQuery();
  const currentUsername = currentUserData?.user?.username;
  const deleteUser = useDeleteUser();
  const withReturnTo = useWithSettingsReturnTo();
  // Bulk-delete + row checkboxes are platform-admin-only; Create User is
  // open to workspace admins. ``rolesScopeWorkspace`` keeps the per-row
  // Roles cell aligned with the page's per-workspace scope: workspace
  // managers should only see roles in the active workspace, including for
  // their own row (the backend self-check returns global roles).
  const isAdmin = useCurrentUserIsAdmin();
  const isWorkspaceAdmin = useCurrentUserIsWorkspaceAdmin();
  const canCreateUser = isAdmin || isWorkspaceAdmin;
  const activeWorkspace = useActiveWorkspace();
  const rolesScopeWorkspace = isAdmin ? null : activeWorkspace;

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const users = useMemo(() => usersData?.users ?? [], [usersData]);
  const {
    visibleSelected: visibleSelectedUsernames,
    isAllSelected: allSelected,
    toggleItem: toggleUserSelection,
    toggleAll: toggleSelectAll,
    clear: clearSelection,
  } = useTableSelection(users, 'username');

  const handleBulkDelete = async () => {
    setError(null);
    const targets = Array.from(visibleSelectedUsernames);
    // Detect self-delete *before* firing the requests so we can fall through
    // to ``performLogout`` even if e.g. only the self-delete row succeeds.
    const includesSelfDelete = currentUsername != null && visibleSelectedUsernames.has(currentUsername);
    const results = await Promise.allSettled(targets.map((u) => deleteUser.mutateAsync(u)));
    const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (failures.length > 0) {
      setError(`Failed to delete ${failures.length}/${targets.length} users: ${failures[0].reason?.message ?? ''}`);
    }
    clearSelection();
    setBulkDeleteOpen(false);
    // If the current user just deleted themselves and the request succeeded,
    // the browser still has stale Basic Auth credentials that will 401 every
    // subsequent request. Force a logout to clear the cached realm.
    const selfDeleteIndex = currentUsername != null ? targets.indexOf(currentUsername) : -1;
    const selfDeleteSucceeded =
      includesSelfDelete && selfDeleteIndex >= 0 && results[selfDeleteIndex]?.status === 'fulfilled';
    if (selfDeleteSucceeded) {
      await performLogout(queryClient);
    }
  };

  if (isLoading) {
    return (
      <div
        css={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.spacing.sm,
          padding: theme.spacing.lg,
          minHeight: 200,
        }}
      >
        <Spinner size="small" />
      </div>
    );
  }

  if (queryError) {
    return (
      <Alert
        componentId="admin.users.query_error"
        type="error"
        message="Failed to load users"
        description={(queryError as Error)?.message || 'An error occurred while fetching users.'}
      />
    );
  }

  const emptyState =
    users.length === 0 ? (
      <Empty
        title={<FormattedMessage defaultMessage="No users" description="Empty state title for users table" />}
        description={
          <FormattedMessage
            defaultMessage="Create a user to get started."
            description="Empty state description for users table"
          />
        }
      />
    ) : null;

  const isGlobalAdmin = Boolean(currentUserData?.user?.is_global_admin ?? currentUserData?.user?.is_admin);

  return (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
      {isGlobalAdmin && <GlobalAdminsSection />}
      <TeamMembersSection />
      {error && (
        <Alert componentId="admin.users.error" type="error" message={error} closable onClose={() => setError(null)} />
      )}
      {canCreateUser && (
        <div
          css={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: theme.spacing.sm,
          }}
        >
          {isAdmin && (
            <Button
              componentId="admin.users.bulk_delete_button"
              danger
              disabled={visibleSelectedUsernames.size === 0}
              onClick={() => setBulkDeleteOpen(true)}
            >
              {visibleSelectedUsernames.size === 0 ? (
                <FormattedMessage
                  defaultMessage="Delete"
                  description="Bulk-delete button on the users table (no rows selected)"
                />
              ) : (
                <FormattedMessage
                  defaultMessage="Delete ({count})"
                  description="Bulk-delete button on the users table"
                  values={{ count: visibleSelectedUsernames.size }}
                />
              )}
            </Button>
          )}
          <Button componentId="admin.users.create_button" type="primary" onClick={() => setShowCreateModal(true)}>
            <FormattedMessage defaultMessage="Create User" description="Button to create a new user" />
          </Button>
        </div>
      )}
      <Table
        scrollable
        noMinHeight
        empty={emptyState}
        css={{
          border: `1px solid ${theme.colors.border}`,
          borderRadius: theme.general.borderRadiusBase,
          overflow: 'hidden',
        }}
      >
        <TableRow isHeader>
          {isAdmin && (
            <TableHeader componentId="admin.users.select_header" css={{ flex: 0, minWidth: 40, maxWidth: 40 }}>
              <Checkbox
                componentId="admin.users.select_all"
                isChecked={allSelected}
                onChange={toggleSelectAll}
                aria-label="Select all users"
              />
            </TableHeader>
          )}
          <TableHeader componentId="admin.users.username_header" css={{ flex: 2 }}>
            <FormattedMessage defaultMessage="Username" description="Users table username header" />
          </TableHeader>
          <TableHeader componentId="admin.users.roles_header" css={{ flex: 2 }}>
            <FormattedMessage
              defaultMessage="Roles"
              description="Users table roles header — roles render as multiple <workspace> → <role_name> lines per user"
            />
          </TableHeader>
          <TableHeader componentId="admin.users.admin_header" css={{ flex: 1 }}>
            <FormattedMessage defaultMessage="Admin" description="Users table admin header" />
          </TableHeader>
        </TableRow>
        {users.map((user) => (
          <TableRow key={user.username}>
            {isAdmin && (
              <TableCell css={{ flex: 0, minWidth: 40, maxWidth: 40 }}>
                <Checkbox
                  componentId="admin.users.select_row"
                  isChecked={visibleSelectedUsernames.has(user.username)}
                  onChange={() => toggleUserSelection(user.username)}
                  aria-label={`Select user ${user.username}`}
                />
              </TableCell>
            )}
            <TableCell css={{ flex: 2 }}>
              <Link
                componentId="admin.users.username_link"
                to={withReturnTo(AdminRoutes.getUserDetailRoute(user.username))}
              >
                {user.username}
              </Link>
            </TableCell>
            <TableCell css={{ flex: 2 }}>
              <UserRolesCell roles={user.roles ?? []} scopeWorkspace={rolesScopeWorkspace} />
            </TableCell>
            <TableCell css={{ flex: 1 }}>
              {user.is_admin ? (
                <Tag componentId="admin.users.admin_tag" color="indigo">
                  Admin
                </Tag>
              ) : (
                <Typography.Text color="secondary">—</Typography.Text>
              )}
            </TableCell>
          </TableRow>
        ))}
      </Table>
      <CreateUserModal open={showCreateModal} onClose={() => setShowCreateModal(false)} />
      <ConfirmationModal
        componentId="admin.users.bulk_delete_modal"
        title="Delete users"
        visible={bulkDeleteOpen}
        onCancel={() => setBulkDeleteOpen(false)}
        onConfirm={handleBulkDelete}
        isLoading={deleteUser.isLoading}
        message={
          <>
            Delete {visibleSelectedUsernames.size} user{visibleSelectedUsernames.size === 1 ? '' : 's'}? This action
            cannot be undone.
          </>
        }
      />
    </div>
  );
};

const RolesTab = () => {
  const { theme } = useDesignSystemTheme();
  // Per-workspace scope: platform admins fetch unscoped; workspace managers
  // pass the active workspace (only one viewable at a time on this page).
  // ``canManageRoles`` checks the *active* workspace specifically — managing
  // workspace A while currently in B means we can't create/delete here.
  const isAdmin = useCurrentUserIsAdmin();
  const adminWorkspaces = useCurrentUserAdminWorkspaces();
  const activeWorkspace = useActiveWorkspace();
  const canManageRoles = isAdmin || (activeWorkspace !== null && adminWorkspaces.has(activeWorkspace));
  const queryWorkspace = isAdmin ? undefined : (activeWorkspace ?? undefined);
  const queryEnabled = isAdmin || Boolean(activeWorkspace);
  const { data: rolesData, isLoading, error: queryError } = useRolesQuery(queryWorkspace, { enabled: queryEnabled });
  const deleteRole = useDeleteRole();
  const withReturnTo = useWithSettingsReturnTo();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roles = useMemo(() => rolesData?.roles ?? [], [rolesData]);
  const {
    visibleSelected: visibleSelectedRoleIds,
    isAllSelected: allSelected,
    toggleItem: toggleRoleSelection,
    toggleAll: toggleSelectAll,
    clear: clearSelection,
  } = useTableSelection(roles, 'id');

  const handleBulkDelete = async () => {
    setError(null);
    const targets = Array.from(visibleSelectedRoleIds);
    const results = await Promise.allSettled(targets.map((id) => deleteRole.mutateAsync(id)));
    const failures = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (failures.length > 0) {
      setError(`Failed to delete ${failures.length}/${targets.length} roles: ${failures[0].reason?.message ?? ''}`);
    }
    clearSelection();
    setBulkDeleteOpen(false);
  };

  // No active workspace + non-admin: skip the guaranteed 403, prompt instead.
  if (!queryEnabled) {
    return (
      <Empty
        title={
          <FormattedMessage
            defaultMessage="Select a workspace"
            description="Roles tab empty state shown to workspace admins without an active workspace"
          />
        }
        description={
          <FormattedMessage
            defaultMessage="Pick a workspace from the workspace selector to see its roles."
            description="Roles tab empty state body when no workspace is selected"
          />
        }
      />
    );
  }

  if (isLoading) {
    return (
      <div
        css={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.spacing.sm,
          padding: theme.spacing.lg,
          minHeight: 200,
        }}
      >
        <Spinner size="small" />
      </div>
    );
  }

  if (queryError) {
    return (
      <Alert
        componentId="admin.roles.query_error"
        type="error"
        message="Failed to load roles"
        description={(queryError as Error)?.message || 'An error occurred while fetching roles.'}
      />
    );
  }

  const emptyState =
    roles.length === 0 ? (
      <Empty
        title={<FormattedMessage defaultMessage="No roles" description="Empty state title for roles table" />}
        description={
          <FormattedMessage
            defaultMessage="Create a role to assign permissions to users."
            description="Empty state description for roles table"
          />
        }
      />
    ) : null;

  return (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
      {error && (
        <Alert componentId="admin.roles.error" type="error" message={error} closable onClose={() => setError(null)} />
      )}
      <div
        css={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: theme.spacing.sm,
        }}
      >
        {canManageRoles && (
          <Button
            componentId="admin.roles.bulk_delete_button"
            danger
            disabled={visibleSelectedRoleIds.size === 0}
            onClick={() => setBulkDeleteOpen(true)}
          >
            {visibleSelectedRoleIds.size === 0 ? (
              <FormattedMessage
                defaultMessage="Delete"
                description="Bulk-delete button on the roles table (no rows selected)"
              />
            ) : (
              <FormattedMessage
                defaultMessage="Delete ({count})"
                description="Bulk-delete button on the roles table"
                values={{ count: visibleSelectedRoleIds.size }}
              />
            )}
          </Button>
        )}
        {canManageRoles && (
          <Button componentId="admin.roles.create_button" type="primary" onClick={() => setShowCreateModal(true)}>
            <FormattedMessage defaultMessage="Create Role" description="Button to create a new role" />
          </Button>
        )}
      </div>
      <Table
        scrollable
        noMinHeight
        empty={emptyState}
        css={{
          border: `1px solid ${theme.colors.border}`,
          borderRadius: theme.general.borderRadiusBase,
          overflow: 'hidden',
        }}
      >
        <TableRow isHeader>
          {canManageRoles && (
            <TableHeader componentId="admin.roles.select_header" css={{ flex: 0, minWidth: 40, maxWidth: 40 }}>
              <Checkbox
                componentId="admin.roles.select_all"
                isChecked={allSelected}
                onChange={toggleSelectAll}
                aria-label="Select all roles"
              />
            </TableHeader>
          )}
          <TableHeader componentId="admin.roles.name_header" css={{ flex: 2 }}>
            <FormattedMessage defaultMessage="Name" description="Roles table name header" />
          </TableHeader>
          <TableHeader componentId="admin.roles.workspace_header" css={{ flex: 1 }}>
            <FormattedMessage defaultMessage="Workspace" description="Roles table workspace header" />
          </TableHeader>
          <TableHeader componentId="admin.roles.description_header" css={{ flex: 2 }}>
            <FormattedMessage defaultMessage="Description" description="Roles table description header" />
          </TableHeader>
          <TableHeader componentId="admin.roles.admin_role_header" css={{ flex: 1 }}>
            <FormattedMessage
              defaultMessage="Workspace Manager"
              description="Roles table column flagging roles that grant workspace-level MANAGE"
            />
          </TableHeader>
        </TableRow>
        {roles.map((role) => (
          <TableRow key={role.id}>
            {canManageRoles && (
              <TableCell css={{ flex: 0, minWidth: 40, maxWidth: 40 }}>
                <Checkbox
                  componentId="admin.roles.select_row"
                  isChecked={visibleSelectedRoleIds.has(role.id)}
                  onChange={() => toggleRoleSelection(role.id)}
                  aria-label={`Select role ${role.name}`}
                />
              </TableCell>
            )}
            <TableCell css={{ flex: 2 }}>
              <Link componentId="admin.roles.name_link" to={withReturnTo(AdminRoutes.getRoleDetailRoute(role.id))}>
                {role.name}
              </Link>
            </TableCell>
            <TableCell css={{ flex: 1 }}>{role.workspace}</TableCell>
            <TableCell css={{ flex: 2 }}>{role.description || '-'}</TableCell>
            <TableCell css={{ flex: 1 }}>
              {isWorkspaceAdminRole(role) ? (
                <Tag componentId="admin.roles.admin_tag" color="indigo">
                  Manager
                </Tag>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </Table>
      <CreateRoleModal open={showCreateModal} onClose={() => setShowCreateModal(false)} />
      <ConfirmationModal
        componentId="admin.roles.bulk_delete_modal"
        title="Delete roles"
        visible={bulkDeleteOpen}
        onCancel={() => setBulkDeleteOpen(false)}
        onConfirm={handleBulkDelete}
        isLoading={deleteRole.isLoading}
        message={
          <>
            Delete {visibleSelectedRoleIds.size} role{visibleSelectedRoleIds.size === 1 ? '' : 's'}? This action cannot
            be undone.
          </>
        }
      />
    </div>
  );
};

const ProjectsTab = () => {
  const { theme } = useDesignSystemTheme();
  const { data, isLoading, error } = useExperimentsQuery();
  const createExperiment = useCreateExperiment();
  const deleteExperiment = useDeleteExperiment();
  const renameExperiment = useRenameExperiment();
  const isAdmin = useCurrentUserIsAdmin();

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [permissionsTarget, setPermissionsTarget] = useState<{ id: string; name: string } | null>(null);

  // Inline rename state: maps experimentId → draft name (undefined = not editing)
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const startRename = (id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
    setRenameError(null);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
    setRenameError(null);
  };

  const commitRename = async (experimentId: string) => {
    setRenameError(null);
    if (!renameValue.trim()) {
      setRenameError('Name cannot be empty');
      return;
    }
    try {
      await renameExperiment.mutateAsync({ experimentId, newName: renameValue.trim() });
      setRenamingId(null);
    } catch (e: unknown) {
      setRenameError(e instanceof Error ? e.message : 'Failed to rename project');
    }
  };

  const experiments = useMemo(
    () => (data?.experiments ?? []).filter((e) => e.lifecycle_stage === 'active'),
    [data],
  );

  const handleCreate = async () => {
    setCreateError(null);
    if (!newName.trim()) {
      setCreateError('Project name cannot be empty');
      return;
    }
    try {
      await createExperiment.mutateAsync(newName.trim());
      setNewName('');
      setShowCreate(false);
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create project');
    }
  };

  const handleDelete = async (experimentId: string) => {
    setDeleteError(null);
    try {
      await deleteExperiment.mutateAsync(experimentId);
    } catch (e: unknown) {
      setDeleteError(e instanceof Error ? e.message : 'Failed to delete project');
    }
  };

  if (isLoading) {
    return (
      <div
        css={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.spacing.sm,
          padding: theme.spacing.lg,
          minHeight: 200,
        }}
      >
        <Spinner size="small" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert
        componentId="admin.projects.query_error"
        type="error"
        message="Failed to load projects"
        description={(error as Error)?.message || 'An error occurred while fetching projects.'}
      />
    );
  }

  const emptyState =
    experiments.length === 0 ? (
      <Empty
        title={<FormattedMessage defaultMessage="No projects" description="Empty state title for projects table" />}
        description={
          <FormattedMessage
            defaultMessage="Create a project to get started."
            description="Empty state description for projects table"
          />
        }
      />
    ) : null;

  return (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
      {deleteError && (
        <Alert
          componentId="admin.projects.delete_error"
          type="error"
          message={deleteError}
          closable
          onClose={() => setDeleteError(null)}
        />
      )}
      <div css={{ display: 'flex', justifyContent: 'flex-end' }}>
        {isAdmin && (
          <Button
            componentId="admin.projects.create_button"
            type="primary"
            onClick={() => setShowCreate(true)}
          >
            <FormattedMessage defaultMessage="Create Project" description="Button to create a new project" />
          </Button>
        )}
      </div>
      <Table
        scrollable
        noMinHeight
        empty={emptyState}
        css={{
          border: `1px solid ${theme.colors.border}`,
          borderRadius: theme.general.borderRadiusBase,
          overflow: 'hidden',
        }}
      >
        <TableRow isHeader>
          <TableHeader componentId="admin.projects.name_header" css={{ flex: 3 }}>
            <FormattedMessage defaultMessage="Project name" description="Projects table name header" />
          </TableHeader>
          <TableHeader componentId="admin.projects.id_header" css={{ flex: 1 }}>
            <FormattedMessage defaultMessage="ID" description="Projects table experiment ID header" />
          </TableHeader>
          <TableHeader componentId="admin.projects.actions_header" css={{ flex: 2 }}>
            <FormattedMessage defaultMessage="Actions" description="Projects table actions header" />
          </TableHeader>
        </TableRow>
        {experiments.map((exp) => {
          const isRenaming = renamingId === exp.experiment_id;
          return (
            <TableRow key={exp.experiment_id}>
              {/* Name cell — inline editable */}
              <TableCell css={{ flex: 3 }}>
                {isRenaming ? (
                  <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
                    <div css={{ display: 'flex', gap: theme.spacing.xs, alignItems: 'center' }}>
                      <Input
                        componentId="admin.projects.rename_input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(exp.experiment_id);
                          if (e.key === 'Escape') cancelRename();
                        }}
                        autoFocus
                        css={{ flex: 1 }}
                      />
                      <Button
                        componentId="admin.projects.rename_save"
                        type="primary"
                        size="small"
                        loading={renameExperiment.isLoading}
                        onClick={() => commitRename(exp.experiment_id)}
                      >
                        <FormattedMessage defaultMessage="Save" description="Save rename button" />
                      </Button>
                      <Button
                        componentId="admin.projects.rename_cancel"
                        type="tertiary"
                        size="small"
                        onClick={cancelRename}
                      >
                        <FormattedMessage defaultMessage="Cancel" description="Cancel rename button" />
                      </Button>
                    </div>
                    {renameError && (
                      <Alert
                        componentId="admin.projects.rename_error"
                        type="error"
                        message={renameError}
                        closable
                        onClose={() => setRenameError(null)}
                      />
                    )}
                  </div>
                ) : (
                  <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.xs }}>
                    <Typography.Text>{exp.name}</Typography.Text>
                    <Button
                      componentId="admin.projects.rename_button"
                      type="tertiary"
                      size="small"
                      onClick={() => startRename(exp.experiment_id, exp.name)}
                      css={{ opacity: 0.5, '&:hover': { opacity: 1 } }}
                    >
                      <FormattedMessage defaultMessage="Rename" description="Rename project button" />
                    </Button>
                  </div>
                )}
              </TableCell>
              <TableCell css={{ flex: 1 }}>
                <Typography.Text color="secondary">{exp.experiment_id}</Typography.Text>
              </TableCell>
              <TableCell css={{ flex: 2 }}>
                <div css={{ display: 'flex', gap: theme.spacing.xs }}>
                  <Button
                    componentId="admin.projects.permissions_button"
                    type="tertiary"
                    size="small"
                    onClick={() => setPermissionsTarget({ id: exp.experiment_id, name: exp.name })}
                  >
                    <FormattedMessage defaultMessage="Manage access" description="Button to open project permissions" />
                  </Button>
                  {isAdmin && (
                    <Button
                      componentId="admin.projects.delete_button"
                      type="tertiary"
                      danger
                      size="small"
                      loading={deleteExperiment.isLoading}
                      onClick={() => handleDelete(exp.experiment_id)}
                    >
                      <FormattedMessage defaultMessage="Delete" description="Delete project button" />
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </Table>

      {/* Create project modal */}
      <Modal
        componentId="admin.projects.create_modal"
        title="Create project"
        visible={showCreate}
        onCancel={() => {
          setShowCreate(false);
          setNewName('');
          setCreateError(null);
        }}
        onOk={handleCreate}
        okText="Create"
        confirmLoading={createExperiment.isLoading}
      >
        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
          {createError && (
            <Alert
              componentId="admin.projects.create_error"
              type="error"
              message={createError}
              closable
              onClose={() => setCreateError(null)}
            />
          )}
          <Typography.Text bold>Project name</Typography.Text>
          <Input
            componentId="admin.projects.name_input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="e.g. my-experiment"
            autoFocus
          />
        </div>
      </Modal>

      {/* Permissions modal */}
      {permissionsTarget && (
        <ProjectPermissionsModal
          open
          onClose={() => setPermissionsTarget(null)}
          experimentId={permissionsTarget.id}
          experimentName={permissionsTarget.name}
        />
      )}
    </div>
  );
};

const ModelsTab = () => {
  const { theme } = useDesignSystemTheme();
  const { data, isLoading, error } = useRegisteredModelsQuery();
  const setVisibility = useSetModelVisibility();
  const isAdmin = useCurrentUserIsAdmin();

  const models = useMemo(() => (data as any)?.models ?? [], [data]);

  const handleToggle = async (name: string, current: string) => {
    const next = current === 'public' ? 'team' : 'public';
    await setVisibility.mutateAsync({ name, visibility: next as 'team' | 'public' });
  };

  if (isLoading) {
    return (
      <div css={{ display: 'flex', justifyContent: 'center', padding: theme.spacing.lg }}>
        <Spinner size="small" />
      </div>
    );
  }
  if (error) {
    return (
      <Alert
        componentId="admin.models.error"
        type="error"
        message="Failed to load models"
        description={(error as Error)?.message}
      />
    );
  }

  const emptyState =
    models.length === 0 ? (
      <Empty
        title={<FormattedMessage defaultMessage="No registered models" description="Empty state for models table" />}
        description={
          <FormattedMessage
            defaultMessage="Register a model from a training run to see it here."
            description="Empty state description for models table"
          />
        }
      />
    ) : null;

  return (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
      <div
        css={{
          padding: theme.spacing.sm,
          backgroundColor: theme.colors.backgroundSecondary,
          borderRadius: theme.general.borderRadiusBase,
        }}
      >
        <Typography.Hint>
          <FormattedMessage
            defaultMessage="Public models are readable by any authenticated user across all teams. Team-private models are visible only to members of the owning team."
            description="Model visibility explanation"
          />
        </Typography.Hint>
      </div>
      <Table
        scrollable
        noMinHeight
        empty={emptyState}
        css={{
          border: `1px solid ${theme.colors.border}`,
          borderRadius: theme.general.borderRadiusBase,
          overflow: 'hidden',
        }}
      >
        <TableRow isHeader>
          <TableHeader componentId="admin.models.name_header" css={{ flex: 3 }}>
            <FormattedMessage defaultMessage="Model name" description="Models table name header" />
          </TableHeader>
          <TableHeader componentId="admin.models.versions_header" css={{ flex: 1 }}>
            <FormattedMessage defaultMessage="Versions" description="Models table versions header" />
          </TableHeader>
          <TableHeader componentId="admin.models.visibility_header" css={{ flex: 2 }}>
            <FormattedMessage defaultMessage="Visibility" description="Models table visibility header" />
          </TableHeader>
          {isAdmin && (
            <TableHeader componentId="admin.models.actions_header" css={{ flex: 1 }}>
              <FormattedMessage defaultMessage="Actions" description="Models table actions header" />
            </TableHeader>
          )}
        </TableRow>
        {models.map((model: { name: string; visibility?: string; version_count?: number; tenant?: string }) => {
          const visibility = model.visibility ?? 'team';
          const isPublic = visibility === 'public';
          return (
            <TableRow key={model.name}>
              <TableCell css={{ flex: 3 }}>
                <Typography.Text bold>{model.name}</Typography.Text>
              </TableCell>
              <TableCell css={{ flex: 1 }}>
                <Typography.Text color="secondary">
                  {model.version_count ?? 0}
                </Typography.Text>
              </TableCell>
              <TableCell css={{ flex: 2 }}>
                <Tag
                  componentId="admin.models.visibility_tag"
                  color={isPublic ? 'turquoise' : 'default'}
                >
                  {isPublic ? (
                    <FormattedMessage defaultMessage="Public 🌐" description="Public model visibility tag" />
                  ) : (
                    <FormattedMessage defaultMessage="Team only 🔒" description="Team-private model visibility tag" />
                  )}
                </Tag>
              </TableCell>
              {isAdmin && (
                <TableCell css={{ flex: 1 }}>
                  <Button
                    componentId="admin.models.toggle_visibility"
                    type="tertiary"
                    size="small"
                    loading={setVisibility.isLoading}
                    onClick={() => handleToggle(model.name, visibility)}
                  >
                    {isPublic ? (
                      <FormattedMessage defaultMessage="Make private" description="Make model team-private button" />
                    ) : (
                      <FormattedMessage defaultMessage="Make public" description="Make model public button" />
                    )}
                  </Button>
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </Table>
    </div>
  );
};

const AdminPage = () => {
  const { theme } = useDesignSystemTheme();
  // Reflect the active tab in the URL (?tab=users|roles) so deep links — e.g.
  // the RoleDetailPage breadcrumb back to /admin?tab=roles — land on the
  // expected tab and a refresh preserves it.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab');
  const activeTab =
    tabFromUrl === 'roles' ? 'roles'
    : tabFromUrl === 'projects' ? 'projects'
    : tabFromUrl === 'models' ? 'models'
    : 'users';

  const activeWorkspace = useActiveWorkspace();
  // Mode is path-driven, not role-driven: ``/admin`` is the cross-workspace
  // platform-admin view; ``/admin/ws`` (with the workspace name in the
  // ``?workspace=`` query param) is the per-workspace management view. A
  // deep link reads the same way for anyone authorized to follow it, and
  // the ``?workspace=`` value is still picked up by ``WorkspaceRouterSync``
  // to keep the global ``activeWorkspace`` in sync.
  const { pathname } = useLocation();
  const isWorkspaceScoped = pathname === AdminRoutePaths.workspaceManagementPage;

  // The route definition's static ``getPageTitle`` is set by ``MlflowRootRoute``
  // *after* this component's effects (parent effects run after children's), so
  // we override on a microtask to land last and reflect the per-workspace
  // header in the browser tab.
  useEffect(() => {
    const desired = isWorkspaceScoped ? 'Workspace Manager - MLflow' : 'Platform Admin - MLflow';
    queueMicrotask(() => {
      document.title = desired;
    });
  }, [isWorkspaceScoped]);

  return (
    <ScrollablePageWrapper>
      <div css={{ padding: theme.spacing.md, display: 'flex', flexDirection: 'column', gap: theme.spacing.lg }}>
        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
          <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center' }}>
            <div
              css={{
                borderRadius: theme.borders.borderRadiusSm,
                backgroundColor: theme.colors.backgroundSecondary,
                padding: theme.spacing.sm,
                display: 'flex',
              }}
            >
              <UserIcon />
            </div>
            <Typography.Title withoutMargins level={2}>
              {isWorkspaceScoped ? (
                <FormattedMessage
                  defaultMessage="Workspace Manager"
                  description="Admin page title shown when the URL is scoped to a single workspace via ?workspace=…"
                />
              ) : (
                <FormattedMessage
                  defaultMessage="Platform Admin"
                  description="Admin page title shown when the URL has no ?workspace=… (cross-workspace platform-admin view)"
                />
              )}
            </Typography.Title>
          </div>
          {isWorkspaceScoped && (
            <Typography.Text color="secondary">
              <FormattedMessage
                defaultMessage="Workspace: {workspace}"
                description="Subtitle on the admin page identifying the active workspace when the URL is per-workspace scoped"
                values={{ workspace: <code>{activeWorkspace}</code> }}
              />
            </Typography.Text>
          )}
        </div>
        <Tabs.Root
          componentId="admin.tabs"
          valueHasNoPii
          value={activeTab}
          onValueChange={(value) => {
            const next = new URLSearchParams(searchParams);
            if (value === 'users') {
              next.delete('tab');
            } else {
              next.set('tab', value);
            }
            setSearchParams(next, { replace: true });
          }}
        >
          <Tabs.List>
            <Tabs.Trigger value="users">
              <FormattedMessage defaultMessage="Users" description="Admin users tab" />
            </Tabs.Trigger>
            <Tabs.Trigger value="projects">
              <FormattedMessage defaultMessage="Projects" description="Admin projects tab" />
            </Tabs.Trigger>
            <Tabs.Trigger value="models">
              <FormattedMessage defaultMessage="Models" description="Admin models tab" />
            </Tabs.Trigger>
            <Tabs.Trigger value="roles">
              <FormattedMessage defaultMessage="Roles" description="Admin roles tab" />
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="users" css={{ paddingTop: theme.spacing.md }}>
            <UsersTab />
          </Tabs.Content>
          <Tabs.Content value="projects" css={{ paddingTop: theme.spacing.md }}>
            <ProjectsTab />
          </Tabs.Content>
          <Tabs.Content value="models" css={{ paddingTop: theme.spacing.md }}>
            <ModelsTab />
          </Tabs.Content>
          <Tabs.Content value="roles" css={{ paddingTop: theme.spacing.md }}>
            <RolesTab />
          </Tabs.Content>
        </Tabs.Root>
      </div>
    </ScrollablePageWrapper>
  );
};

export default AdminPage;
