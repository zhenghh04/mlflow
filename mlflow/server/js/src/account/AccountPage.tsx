import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Avatar,
  Button,
  Empty,
  Input,
  Modal,
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
import { FormattedMessage, useIntl } from 'react-intl';
import { ScrollablePageWrapper } from '@mlflow/mlflow/src/common/components/ScrollablePageWrapper';
import { useMutation, useQuery, useQueryClient } from '@mlflow/mlflow/src/common/utils/reactQueryHooks';
import { useWorkspacesEnabled } from '../experiment-tracking/hooks/useServerInfo';
import { useSearchParams } from '../common/utils/RoutingUtils';
import { performLogout } from './auth-utils';
import {
  useCurrentUserQuery,
  useIsBasicAuth,
  useMyPermissionsQuery,
  useUpdatePassword,
  useUserRolesQuery,
} from './hooks';
import { PermissionsSection } from './PermissionsSection';
import { DEFAULT_WORKSPACE_NAME, isWorkspaceAdminRole } from './types';
import type { Role } from './types';
import { AccountApi } from './api';

// ─── types ───────────────────────────────────────────────────────────────────

interface TeamEntry {
  slug: string;
  name: string;
  role: string;
}

interface ProfileData {
  id: number;
  username: string;
  is_admin: boolean;
  display_name?: string;
  email?: string;
  title?: string;
  department?: string;
  location?: string;
  bio?: string;
  github?: string;
  orcid?: string;
  avatar_url?: string;
  teams?: TeamEntry[];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const getActiveTenantSlug = (): string => {
  const raw =
    document.cookie
      .split('; ')
      .find((row) => row.startsWith('mlflow_tenant='))
      ?.substring('mlflow_tenant='.length) ?? '';
  try {
    return decodeURIComponent(raw) || 'default';
  } catch {
    return raw || 'default';
  }
};

/** Resize a File to a 128×128 data-URL via an offscreen canvas. */
const resizeAvatar = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = (ev) => {
      const src = ev.target?.result as string;
      const img = new Image();
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas not available'));
          return;
        }
        // Centre-crop to square then scale
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, 128, 128);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });

/** Pick a deterministic background colour from an initial letter. */
const initialsColor = (initial: string): string => {
  const palette = ['#4c84d6', '#7b61d6', '#d66b4c', '#4cad7b', '#d6b84c', '#d64c7b'];
  const idx = (initial.toUpperCase().charCodeAt(0) - 65) % palette.length;
  return palette[Math.max(0, idx)];
};

// ─── sub-components ──────────────────────────────────────────────────────────

const TenantBadge = () => {
  const slug = getActiveTenantSlug();
  return (
    <Tag componentId="account.tenant_tag" color="default">
      {slug}
    </Tag>
  );
};

const AccountRoleRow = ({ role, workspacesEnabled }: { role: Role; workspacesEnabled: boolean }) => (
  <TableRow>
    <TableCell css={{ flex: 2 }}>{role.name}</TableCell>
    {workspacesEnabled && <TableCell css={{ flex: 1 }}>{role.workspace}</TableCell>}
    <TableCell css={{ flex: 1 }}>
      {isWorkspaceAdminRole(role) ? (
        <Tag componentId="account.role_admin_tag" color="indigo">
          {workspacesEnabled ? (
            <FormattedMessage defaultMessage="Manager" description="Workspace-admin role tag (multi-tenant)" />
          ) : (
            <FormattedMessage defaultMessage="Admin" description="Admin role tag (single-tenant)" />
          )}
        </Tag>
      ) : null}
    </TableCell>
  </TableRow>
);

// ─── ProfileAvatar ────────────────────────────────────────────────────────────

interface ProfileAvatarProps {
  profile: ProfileData | undefined;
  onAvatarUploaded: (dataUrl: string) => void;
  isUploading: boolean;
}

const ProfileAvatar = ({ profile, onAvatarUploaded, isUploading }: ProfileAvatarProps) => {
  const { theme } = useDesignSystemTheme();
  const intl = useIntl();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const initial = (profile?.display_name ?? profile?.username ?? '?')[0].toUpperCase();
  const bgColor = initialsColor(initial);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLocalError(null);
    try {
      const dataUrl = await resizeAvatar(file);
      onAvatarUploaded(dataUrl);
    } catch (err) {
      setLocalError(
        intl.formatMessage({
          defaultMessage: 'Failed to process image',
          description: 'Error shown when avatar image processing fails',
        }),
      );
    }
    // reset so the same file can be re-selected
    e.target.value = '';
  };

  return (
    <div css={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: theme.spacing.xs }}>
      {profile?.avatar_url ? (
        <img
          src={profile.avatar_url}
          alt={intl.formatMessage({ defaultMessage: 'Avatar', description: 'Alt text for profile avatar image' })}
          css={{
            width: 96,
            height: 96,
            borderRadius: '50%',
            objectFit: 'cover',
            border: `2px solid ${theme.colors.border}`,
          }}
        />
      ) : (
        <div
          css={{
            width: 96,
            height: 96,
            borderRadius: '50%',
            backgroundColor: bgColor,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Typography.Title level={2} withoutMargins css={{ color: '#fff', lineHeight: 1 }}>
            {initial}
          </Typography.Title>
        </div>
      )}

      {isUploading ? (
        <Spinner size="small" />
      ) : (
        <Button
          componentId="account.avatar_upload_button"
          type="tertiary"
          size="small"
          onClick={() => fileInputRef.current?.click()}
        >
          <FormattedMessage defaultMessage="Upload photo" description="Button to upload a profile photo" />
        </Button>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        aria-label={intl.formatMessage({
          defaultMessage: 'Upload profile photo',
          description: 'Accessible label for the hidden file input used to upload an avatar',
        })}
        css={{ display: 'none' }}
        onChange={handleFile}
      />

      {localError && (
        <Alert
          componentId="account.avatar_error"
          type="error"
          message={localError}
          closable
          onClose={() => setLocalError(null)}
        />
      )}
    </div>
  );
};

// ─── EditProfileModal ─────────────────────────────────────────────────────────

interface EditProfileModalProps {
  profile: ProfileData;
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const EditProfileModal = ({ profile, visible, onClose, onSaved }: EditProfileModalProps) => {
  const { theme } = useDesignSystemTheme();
  const intl = useIntl();
  const queryClient = useQueryClient();

  const [displayName, setDisplayName] = useState(profile.display_name ?? '');
  const [email, setEmail] = useState(profile.email ?? '');
  const [title, setTitle] = useState(profile.title ?? '');
  const [department, setDepartment] = useState(profile.department ?? '');
  const [location, setLocation] = useState(profile.location ?? '');
  const [github, setGithub] = useState(profile.github ?? '');
  const [orcid, setOrcid] = useState(profile.orcid ?? '');
  const [bio, setBio] = useState(profile.bio ?? '');
  const [saveError, setSaveError] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: AccountApi.updateProfile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account_current_user'] });
      queryClient.invalidateQueries({ queryKey: ['account_profile'] });
      setSaveError(null);
      onSaved();
      onClose();
    },
    onError: (err: unknown) => {
      setSaveError(
        err instanceof Error
          ? err.message
          : intl.formatMessage({
              defaultMessage: 'Failed to save profile',
              description: 'Generic error when profile save fails',
            }),
      );
    },
  });

  const handleSave = () => {
    const fields: Parameters<typeof AccountApi.updateProfile>[0] = {};
    if (displayName !== (profile.display_name ?? '')) fields.display_name = displayName;
    if (email !== (profile.email ?? '')) fields.email = email;
    if (title !== (profile.title ?? '')) fields.title = title;
    if (department !== (profile.department ?? '')) fields.department = department;
    if (location !== (profile.location ?? '')) fields.location = location;
    if (github !== (profile.github ?? '')) fields.github = github;
    if (orcid !== (profile.orcid ?? '')) fields.orcid = orcid;
    if (bio !== (profile.bio ?? '')) fields.bio = bio;
    updateMutation.mutate(fields);
  };

  const field = (
    label: React.ReactNode,
    value: string,
    onChange: (v: string) => void,
    componentId: string,
    placeholder?: string,
  ) => (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
      <Typography.Text bold>{label}</Typography.Text>
      <Input
        componentId={componentId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );

  return (
    <Modal
      componentId="account.edit_profile_modal"
      title={intl.formatMessage({ defaultMessage: 'Edit Profile', description: 'Edit profile modal title' })}
      visible={visible}
      onCancel={onClose}
      onOk={handleSave}
      okText={intl.formatMessage({ defaultMessage: 'Save', description: 'Save button in edit profile modal' })}
      confirmLoading={updateMutation.isLoading}
    >
      <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
        {saveError && (
          <Alert
            componentId="account.edit_profile_modal.error"
            type="error"
            message={saveError}
            closable
            onClose={() => setSaveError(null)}
          />
        )}

        <div
          css={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: theme.spacing.md,
          }}
        >
          {field(
            <FormattedMessage defaultMessage="Display Name" description="Display name field label" />,
            displayName,
            setDisplayName,
            'account.edit_profile.display_name',
            intl.formatMessage({ defaultMessage: 'Your name', description: 'Display name placeholder' }),
          )}
          {field(
            <FormattedMessage defaultMessage="Email" description="Email field label" />,
            email,
            setEmail,
            'account.edit_profile.email',
            intl.formatMessage({ defaultMessage: 'you@example.com', description: 'Email placeholder' }),
          )}
          {field(
            <FormattedMessage defaultMessage="Title" description="Title field label" />,
            title,
            setTitle,
            'account.edit_profile.title',
            intl.formatMessage({ defaultMessage: 'e.g. Senior Researcher', description: 'Title placeholder' }),
          )}
          {field(
            <FormattedMessage defaultMessage="Department" description="Department field label" />,
            department,
            setDepartment,
            'account.edit_profile.department',
            intl.formatMessage({ defaultMessage: 'e.g. Engineering', description: 'Department placeholder' }),
          )}
          {field(
            <FormattedMessage defaultMessage="Location" description="Location field label" />,
            location,
            setLocation,
            'account.edit_profile.location',
            intl.formatMessage({ defaultMessage: 'e.g. Chicago, IL', description: 'Location placeholder' }),
          )}
          {field(
            <FormattedMessage defaultMessage="GitHub" description="GitHub field label" />,
            github,
            setGithub,
            'account.edit_profile.github',
            intl.formatMessage({ defaultMessage: 'github username', description: 'GitHub placeholder' }),
          )}
          {field(
            <FormattedMessage defaultMessage="ORCID" description="ORCID field label" />,
            orcid,
            setOrcid,
            'account.edit_profile.orcid',
            intl.formatMessage({
              defaultMessage: '0000-0000-0000-0000',
              description: 'ORCID placeholder',
            }),
          )}
        </div>

        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
          <Typography.Text bold>
            <FormattedMessage defaultMessage="Bio" description="Bio field label" />
          </Typography.Text>
          <Input
            componentId="account.edit_profile.bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder={intl.formatMessage({
              defaultMessage: 'Short bio…',
              description: 'Bio input placeholder',
            })}
          />
        </div>
      </div>
    </Modal>
  );
};

// ─── TeamsTable ───────────────────────────────────────────────────────────────

const TeamsTable = ({ teams }: { teams: TeamEntry[] }) => {
  const { theme } = useDesignSystemTheme();
  const intl = useIntl();

  if (teams.length === 0) {
    return (
      <Empty
        title={intl.formatMessage({
          defaultMessage: 'No teams',
          description: 'Empty state title for teams table',
        })}
        description={intl.formatMessage({
          defaultMessage: 'You are not a member of any teams.',
          description: 'Empty state description for teams table',
        })}
      />
    );
  }

  return (
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
        <TableHeader componentId="account.teams.name_header" css={{ flex: 2 }}>
          <FormattedMessage defaultMessage="Team" description="Teams table column header: team name" />
        </TableHeader>
        <TableHeader componentId="account.teams.slug_header" css={{ flex: 1 }}>
          <FormattedMessage defaultMessage="Slug" description="Teams table column header: team slug" />
        </TableHeader>
        <TableHeader componentId="account.teams.role_header" css={{ flex: 1 }}>
          <FormattedMessage defaultMessage="Role" description="Teams table column header: team role" />
        </TableHeader>
      </TableRow>
      {teams.map((t) => (
        <TableRow key={t.slug}>
          <TableCell css={{ flex: 2 }}>{t.name}</TableCell>
          <TableCell css={{ flex: 1 }}>
            <code>{t.slug}</code>
          </TableCell>
          <TableCell css={{ flex: 1 }}>
            <Tag componentId="account.teams.role_tag" color={t.role === 'admin' ? 'indigo' : 'default'}>
              {t.role}
            </Tag>
          </TableCell>
        </TableRow>
      ))}
    </Table>
  );
};

// ─── InfoGrid ────────────────────────────────────────────────────────────────

const InfoRow = ({ label, value }: { label: React.ReactNode; value?: string }) => {
  const { theme } = useDesignSystemTheme();
  return (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs / 2 }}>
      <Typography.Text size="sm" color="secondary">
        {label}
      </Typography.Text>
      <Typography.Text>{value || '—'}</Typography.Text>
    </div>
  );
};

// ─── AccountPage ──────────────────────────────────────────────────────────────

const AccountPage = () => {
  const { theme } = useDesignSystemTheme();
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab');
  const activeTab = tabFromUrl === 'permissions' ? 'permissions' : 'roles';

  // ── existing account state ────────────────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);

  const updatePassword = useUpdatePassword();
  const { data: currentUserData, isLoading: currentUserLoading } = useCurrentUserQuery();
  const username = currentUserData?.user?.username ?? '';
  const { workspacesEnabled } = useWorkspacesEnabled();
  const isBasicAuth = useIsBasicAuth();

  // ── profile query ─────────────────────────────────────────────────────────
  const {
    data: profileData,
    isLoading: profileLoading,
    error: profileError,
  } = useQuery({
    queryKey: ['account_profile'],
    queryFn: AccountApi.getProfile,
    retry: false,
    refetchOnWindowFocus: false,
    enabled: Boolean(username),
  });
  const profile = profileData?.profile;

  // ── avatar upload mutation ────────────────────────────────────────────────
  const avatarMutation = useMutation({
    mutationFn: (dataUrl: string) => AccountApi.updateProfile({ avatar_url: dataUrl }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['account_current_user'] });
      queryClient.invalidateQueries({ queryKey: ['account_profile'] });
    },
  });

  // ── roles / permissions ───────────────────────────────────────────────────
  const { data: rolesData, isLoading: rolesLoading, error: rolesError } = useUserRolesQuery(username);
  const allRoles = useMemo(() => rolesData?.roles ?? [], [rolesData]);

  const { data: directPermsData, isLoading: directPermsLoading, error: directPermsError } = useMyPermissionsQuery();
  const allDirectPermissions = useMemo(() => directPermsData?.permissions ?? [], [directPermsData]);

  const roles = useMemo(
    () => (workspacesEnabled ? allRoles : allRoles.filter((r) => r.workspace === DEFAULT_WORKSPACE_NAME)),
    [allRoles, workspacesEnabled],
  );
  const directPermissions = useMemo(
    () =>
      workspacesEnabled
        ? allDirectPermissions
        : allDirectPermissions.filter((p) => p.workspace == null || p.workspace === DEFAULT_WORKSPACE_NAME),
    [allDirectPermissions, workspacesEnabled],
  );

  // ── change-password ───────────────────────────────────────────────────────
  const closeChangePassword = () => {
    setChangePasswordOpen(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
  };

  const handleChangePassword = async () => {
    setError(null);

    if (!currentPassword) {
      setError(
        intl.formatMessage({
          defaultMessage: 'Current password is required',
          description: 'Validation error when the current-password field is empty',
        }),
      );
      return;
    }
    if (!newPassword) {
      setError(
        intl.formatMessage({
          defaultMessage: 'Password cannot be empty',
          description: 'Validation error when the new-password field is empty',
        }),
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(
        intl.formatMessage({
          defaultMessage: 'New password and confirmation do not match',
          description: 'Validation error when passwords do not match',
        }),
      );
      return;
    }

    try {
      await updatePassword.mutateAsync({ username, password: newPassword, current_password: currentPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setChangePasswordOpen(false);
      performLogout(queryClient);
    } catch (e: unknown) {
      setError(
        e instanceof Error
          ? e.message
          : intl.formatMessage({
              defaultMessage: 'Failed to update password',
              description: 'Generic error when password update fails',
            }),
      );
    }
  };

  // ── empty-state for roles ─────────────────────────────────────────────────
  const rolesEmptyState =
    roles.length === 0 ? (
      <Empty
        title={intl.formatMessage({
          defaultMessage: 'No roles',
          description: 'Empty-state title for the roles table',
        })}
        description={intl.formatMessage({
          defaultMessage: 'You have not been assigned to any roles.',
          description: 'Empty-state description for the roles table',
        })}
      />
    ) : null;

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <ScrollablePageWrapper>
      <div css={{ padding: theme.spacing.md, display: 'flex', flexDirection: 'column', gap: theme.spacing.lg }}>

        {/* ── HEADER ── */}
        <div
          css={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: theme.spacing.lg,
            flexWrap: 'wrap',
          }}
        >
          {/* Left: avatar + name block */}
          <div css={{ display: 'flex', gap: theme.spacing.lg, alignItems: 'flex-start' }}>
            {profileLoading ? (
              <div css={{ width: 96, height: 96, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Spinner size="large" />
              </div>
            ) : (
              <ProfileAvatar
                profile={profile}
                onAvatarUploaded={(dataUrl) => avatarMutation.mutate(dataUrl)}
                isUploading={avatarMutation.isLoading}
              />
            )}

            <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
              <Typography.Title withoutMargins level={2}>
                {profile?.display_name ?? username}
              </Typography.Title>

              {username && (
                <Typography.Text color="secondary" css={{ fontFamily: 'monospace' }}>
                  @{username}
                </Typography.Text>
              )}

              {/* Tenant + team badges */}
              <div css={{ display: 'flex', gap: theme.spacing.xs, flexWrap: 'wrap', marginTop: theme.spacing.xs }}>
                <TenantBadge />
                {profile?.teams?.map((t) => (
                  <Tag
                    key={t.slug}
                    componentId="account.team_badge"
                    color={t.role === 'admin' ? 'indigo' : 'default'}
                  >
                    {t.name}
                    {' · '}
                    {t.role}
                  </Tag>
                ))}
              </div>
            </div>
          </div>

          {/* Right: action buttons */}
          <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
            {username && (
              <Button
                componentId="account.edit_profile_button"
                type="primary"
                onClick={() => setEditProfileOpen(true)}
                disabled={!profile}
              >
                <FormattedMessage defaultMessage="Edit Profile" description="Button to open the edit profile modal" />
              </Button>
            )}
            {isBasicAuth && username && (
              <Button
                componentId="account.change_password_button"
                type="tertiary"
                onClick={() => setChangePasswordOpen(true)}
              >
                <FormattedMessage
                  defaultMessage="Change password"
                  description="Button to open the change password modal"
                />
              </Button>
            )}
            {isBasicAuth && username && (
              <Button
                componentId="account.logout_button"
                type="tertiary"
                onClick={() => performLogout(queryClient)}
              >
                <FormattedMessage defaultMessage="Log out" description="Log-out button on the profile page" />
              </Button>
            )}
          </div>
        </div>

        {/* ── ALERTS ── */}
        {!username && !currentUserLoading && (
          <Alert
            componentId="account.no_user"
            type="warning"
            message={intl.formatMessage({
              defaultMessage: 'Not logged in',
              description: 'Alert title shown when the current user cannot be determined',
            })}
            description={intl.formatMessage({
              defaultMessage: 'Could not determine the current user. Please log in again.',
              description: 'Alert description prompting the user to log in again',
            })}
          />
        )}

        {profileError && (
          <Alert
            componentId="account.profile_error"
            type="warning"
            message={intl.formatMessage({
              defaultMessage: 'Could not load profile',
              description: 'Alert shown when the profile endpoint fails',
            })}
            description={(profileError as Error)?.message}
          />
        )}

        {error && !changePasswordOpen && (
          <Alert componentId="account.error" type="error" message={error} closable onClose={() => setError(null)} />
        )}

        {/* ── INFO GRID ── */}
        {profile && (
          <div
            css={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: theme.spacing.md,
              padding: theme.spacing.md,
              border: `1px solid ${theme.colors.border}`,
              borderRadius: theme.general.borderRadiusBase,
            }}
          >
            <InfoRow
              label={<FormattedMessage defaultMessage="Email" description="Profile info: email label" />}
              value={profile.email}
            />
            <InfoRow
              label={<FormattedMessage defaultMessage="GitHub" description="Profile info: github label" />}
              value={profile.github}
            />
            <InfoRow
              label={<FormattedMessage defaultMessage="Title" description="Profile info: title label" />}
              value={profile.title}
            />
            <InfoRow
              label={<FormattedMessage defaultMessage="ORCID" description="Profile info: orcid label" />}
              value={profile.orcid}
            />
            <InfoRow
              label={<FormattedMessage defaultMessage="Department" description="Profile info: department label" />}
              value={profile.department}
            />
            <InfoRow
              label={<FormattedMessage defaultMessage="Bio" description="Profile info: bio label" />}
              value={profile.bio}
            />
            <InfoRow
              label={<FormattedMessage defaultMessage="Location" description="Profile info: location label" />}
              value={profile.location}
            />
          </div>
        )}

        {/* ── TEAMS TABLE ── */}
        {profile && (
          <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
            <Typography.Title level={4} withoutMargins>
              <FormattedMessage defaultMessage="My Teams" description="Section heading for teams table" />
            </Typography.Title>
            <TeamsTable teams={profile.teams ?? []} />
          </div>
        )}

        {/* ── MODALS ── */}

        {/* Edit Profile modal */}
        {profile && editProfileOpen && (
          <EditProfileModal
            profile={profile}
            visible={editProfileOpen}
            onClose={() => setEditProfileOpen(false)}
            onSaved={() => setEditProfileOpen(false)}
          />
        )}

        {/* Change Password modal */}
        <Modal
          componentId="account.change_password_modal"
          title={intl.formatMessage({
            defaultMessage: 'Change password',
            description: 'Title of the change-password modal',
          })}
          visible={changePasswordOpen}
          onCancel={closeChangePassword}
          onOk={handleChangePassword}
          okText={intl.formatMessage({
            defaultMessage: 'Update password',
            description: 'Confirm button label in the change-password modal',
          })}
          confirmLoading={updatePassword.isLoading}
        >
          <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
            {error && (
              <Alert
                componentId="account.change_password_modal.error"
                type="error"
                message={error}
                closable
                onClose={() => setError(null)}
              />
            )}
            <div>
              <Typography.Text bold>
                <FormattedMessage defaultMessage="Current password" description="Label for the current-password field" />
              </Typography.Text>
              <Input
                componentId="account.current_password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder={intl.formatMessage({
                  defaultMessage: 'Enter current password',
                  description: 'Placeholder for the current-password input',
                })}
              />
            </div>
            <div>
              <Typography.Text bold>
                <FormattedMessage defaultMessage="New password" description="Label for the new-password field" />
              </Typography.Text>
              <Input
                componentId="account.new_password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={intl.formatMessage({
                  defaultMessage: 'Enter new password',
                  description: 'Placeholder for the new-password input',
                })}
              />
            </div>
            <div>
              <Typography.Text bold>
                <FormattedMessage defaultMessage="Confirm password" description="Label for the confirm-password field" />
              </Typography.Text>
              <Input
                componentId="account.confirm_password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={intl.formatMessage({
                  defaultMessage: 'Confirm new password',
                  description: 'Placeholder for the confirm-password input',
                })}
              />
            </div>
          </div>
        </Modal>

        {/* ── ROLES / PERMISSIONS TABS ── */}
        {username && (
          <Tabs.Root
            componentId="account.tabs"
            valueHasNoPii
            value={activeTab}
            onValueChange={(value) => {
              const next = new URLSearchParams(searchParams);
              if (value === 'roles') {
                next.delete('tab');
              } else {
                next.set('tab', value);
              }
              setSearchParams(next, { replace: true });
            }}
          >
            <Tabs.List>
              <Tabs.Trigger value="roles">
                <FormattedMessage defaultMessage="Roles" description="Tab trigger for the user's roles" />
              </Tabs.Trigger>
              <Tabs.Trigger value="permissions">
                <FormattedMessage defaultMessage="Permissions" description="Tab trigger for the user's permissions" />
              </Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="roles" css={{ paddingTop: theme.spacing.md }}>
              {rolesLoading ? (
                <div
                  css={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: theme.spacing.lg,
                    minHeight: 200,
                  }}
                >
                  <Spinner size="small" />
                </div>
              ) : rolesError ? (
                <Alert
                  componentId="account.roles_error"
                  type="error"
                  message={intl.formatMessage({
                    defaultMessage: 'Failed to load roles',
                    description: 'Alert title shown when the roles query fails',
                  })}
                  description={
                    (rolesError as Error)?.message ||
                    intl.formatMessage({
                      defaultMessage: 'An error occurred while fetching your roles.',
                      description: 'Fallback description for the roles error',
                    })
                  }
                />
              ) : (
                <Table
                  scrollable
                  noMinHeight
                  empty={rolesEmptyState}
                  css={{
                    border: `1px solid ${theme.colors.border}`,
                    borderRadius: theme.general.borderRadiusBase,
                    overflow: 'hidden',
                  }}
                >
                  <TableRow isHeader>
                    <TableHeader componentId="account.roles.name_header" css={{ flex: 2 }}>
                      <FormattedMessage defaultMessage="Role" description="Roles table: role name column" />
                    </TableHeader>
                    {workspacesEnabled && (
                      <TableHeader componentId="account.roles.workspace_header" css={{ flex: 1 }}>
                        <FormattedMessage defaultMessage="Workspace" description="Roles table: workspace column" />
                      </TableHeader>
                    )}
                    <TableHeader componentId="account.roles.admin_header" css={{ flex: 1 }}>
                      {workspacesEnabled ? (
                        <FormattedMessage
                          defaultMessage="Workspace Manager"
                          description="Roles table: workspace-admin column (multi-tenant)"
                        />
                      ) : (
                        <FormattedMessage
                          defaultMessage="Admin"
                          description="Roles table: admin column (single-tenant)"
                        />
                      )}
                    </TableHeader>
                  </TableRow>
                  {roles.map((role) => (
                    <AccountRoleRow key={role.id} role={role} workspacesEnabled={workspacesEnabled} />
                  ))}
                </Table>
              )}
            </Tabs.Content>

            <Tabs.Content
              value="permissions"
              css={{ paddingTop: theme.spacing.md, display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}
            >
              <PermissionsSection
                roles={roles}
                directPermissions={directPermissions}
                isLoading={rolesLoading || directPermsLoading}
                rolesError={rolesError}
                directPermsError={directPermsError}
                componentId="account"
                workspacesEnabled={workspacesEnabled}
              />
            </Tabs.Content>
          </Tabs.Root>
        )}
      </div>
    </ScrollablePageWrapper>
  );
};

export default AccountPage;
