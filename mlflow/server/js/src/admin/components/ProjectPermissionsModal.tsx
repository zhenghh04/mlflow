import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  DialogCombobox,
  DialogComboboxContent,
  DialogComboboxOptionList,
  DialogComboboxOptionListSearch,
  DialogComboboxOptionListSelectItem,
  DialogComboboxTrigger,
  Empty,
  Modal,
  SimpleSelect,
  SimpleSelectOption,
  Spinner,
  Table,
  TableCell,
  TableHeader,
  TableRow,
  Tag,
  Typography,
  useDesignSystemTheme,
} from '@databricks/design-system';
import { useQueryClient } from '@mlflow/mlflow/src/common/utils/reactQueryHooks';
import { FormattedMessage, useIntl } from 'react-intl';
import {
  useUsersQuery,
  useGrantExperimentPermission,
  useRevokeExperimentPermission,
  useUpdateExperimentPermission,
  useUserPermissionsQuery,
} from '../hooks';

const PERMISSION_LEVELS = ['READ', 'USE', 'EDIT', 'MANAGE'] as const;
type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

const PERMISSION_COLORS: Record<PermissionLevel, 'default' | 'lemon' | 'indigo' | 'turquoise'> = {
  READ: 'default',
  USE: 'lemon',
  EDIT: 'indigo',
  MANAGE: 'turquoise',
};

interface ProjectPermissionsModalProps {
  open: boolean;
  onClose: () => void;
  experimentId: string;
  experimentName: string;
}

/**
 * One row in the access list: shows the username, their current permission
 * level (loaded from their full permission list), and controls to change or
 * revoke it.
 */
const UserAccessRow = ({
  username,
  experimentId,
  onChanged,
}: {
  username: string;
  experimentId: string;
  onChanged: () => void;
}) => {
  const { theme } = useDesignSystemTheme();
  const { data: permsData, isLoading } = useUserPermissionsQuery(username);
  const grantPermission = useGrantExperimentPermission();
  const revokePermission = useRevokeExperimentPermission();
  const updatePermission = useUpdateExperimentPermission();
  const [editing, setEditing] = useState(false);
  const [selectedLevel, setSelectedLevel] = useState<PermissionLevel>('READ');

  const currentPerm = useMemo(() => {
    const perms = permsData?.permissions ?? [];
    const match = perms.find(
      (p) => p.resource_type === 'experiment' && p.resource_pattern === experimentId,
    );
    return match?.permission ?? null;
  }, [permsData, experimentId]);

  const handleUpdate = async (level: PermissionLevel) => {
    if (currentPerm) {
      await updatePermission.mutateAsync({ experimentId, username, permission: level });
    } else {
      await grantPermission.mutateAsync({ experimentId, username, permission: level });
    }
    setEditing(false);
    onChanged();
  };

  const handleRevoke = async () => {
    await revokePermission.mutateAsync({ experimentId, username });
    onChanged();
  };

  return (
    <TableRow>
      <TableCell css={{ flex: 2 }}>
        <Typography.Text>{username}</Typography.Text>
      </TableCell>
      <TableCell css={{ flex: 2 }}>
        {isLoading ? (
          <Spinner size="small" />
        ) : editing ? (
          <div css={{ display: 'flex', gap: theme.spacing.xs, alignItems: 'center' }}>
            <SimpleSelect
              id="project_perms_edit_level"
              componentId="project_perms.edit_level"
              value={selectedLevel}
              onChange={({ target }) => setSelectedLevel(target.value as PermissionLevel)}
            >
              {PERMISSION_LEVELS.map((lvl) => (
                <SimpleSelectOption key={lvl} value={lvl}>
                  {lvl}
                </SimpleSelectOption>
              ))}
            </SimpleSelect>
            <Button
              componentId="project_perms.confirm_edit"
              type="primary"
              size="small"
              loading={grantPermission.isLoading || updatePermission.isLoading}
              onClick={() => handleUpdate(selectedLevel)}
            >
              <FormattedMessage defaultMessage="Save" description="Save button in project permission row" />
            </Button>
            <Button
              componentId="project_perms.cancel_edit"
              type="tertiary"
              size="small"
              onClick={() => setEditing(false)}
            >
              <FormattedMessage defaultMessage="Cancel" description="Cancel button in project permission row" />
            </Button>
          </div>
        ) : currentPerm ? (
          <Tag
            componentId="project_perms.perm_tag"
            color={PERMISSION_COLORS[currentPerm as PermissionLevel] ?? 'default'}
          >
            {currentPerm}
          </Tag>
        ) : (
          <Typography.Text color="secondary">
            <FormattedMessage defaultMessage="No access" description="No permission assigned" />
          </Typography.Text>
        )}
      </TableCell>
      <TableCell css={{ flex: 1 }}>
        <div css={{ display: 'flex', gap: theme.spacing.xs }}>
          {!editing && (
            <Button
              componentId="project_perms.edit_button"
              type="tertiary"
              size="small"
              onClick={() => {
                setSelectedLevel((currentPerm as PermissionLevel) ?? 'READ');
                setEditing(true);
              }}
            >
              <FormattedMessage defaultMessage="Edit" description="Edit permission button" />
            </Button>
          )}
          {currentPerm && !editing && (
            <Button
              componentId="project_perms.revoke_button"
              type="tertiary"
              danger
              size="small"
              loading={revokePermission.isLoading}
              onClick={handleRevoke}
            >
              <FormattedMessage defaultMessage="Revoke" description="Revoke permission button" />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
};

export const ProjectPermissionsModal = ({
  open,
  onClose,
  experimentId,
  experimentName,
}: ProjectPermissionsModalProps) => {
  const { theme } = useDesignSystemTheme();
  const intl = useIntl();
  const queryClient = useQueryClient();
  const { data: usersData, isLoading: usersLoading } = useUsersQuery();
  const grantPermission = useGrantExperimentPermission();

  const [newUsername, setNewUsername] = useState('');
  const [newPermission, setNewPermission] = useState<PermissionLevel>('READ');
  const [addError, setAddError] = useState<string | null>(null);

  const users = useMemo(() => (usersData?.users ?? []).map((u) => u.username), [usersData]);

  const handleAddAccess = async () => {
    setAddError(null);
    if (!newUsername) {
      setAddError(intl.formatMessage({ defaultMessage: 'Select a user', description: 'Add access validation' }));
      return;
    }
    try {
      await grantPermission.mutateAsync({
        experimentId,
        username: newUsername,
        permission: newPermission,
      });
      setNewUsername('');
      setNewPermission('READ');
      queryClient.invalidateQueries();
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : 'Failed to grant permission');
    }
  };

  return (
    <Modal
      componentId="project_perms.modal"
      title={intl.formatMessage(
        { defaultMessage: 'Manage access — {name}', description: 'Project permissions modal title' },
        { name: experimentName },
      )}
      visible={open}
      onCancel={onClose}
      footer={
        <Button componentId="project_perms.close" onClick={onClose}>
          <FormattedMessage defaultMessage="Close" description="Close button in project permissions modal" />
        </Button>
      }
      size="wide"
    >
      <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.lg }}>
        {/* Add access form */}
        <div
          css={{
            padding: theme.spacing.md,
            border: `1px solid ${theme.colors.border}`,
            borderRadius: theme.general.borderRadiusBase,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing.sm,
          }}
        >
          <Typography.Text bold>
            <FormattedMessage defaultMessage="Grant access" description="Section heading for adding permissions" />
          </Typography.Text>
          {addError && (
            <Alert
              componentId="project_perms.add_error"
              type="error"
              message={addError}
              closable
              onClose={() => setAddError(null)}
            />
          )}
          <div css={{ display: 'flex', gap: theme.spacing.sm, alignItems: 'center', flexWrap: 'wrap' }}>
            <DialogCombobox
              componentId="project_perms.add_user"
              label={intl.formatMessage({ defaultMessage: 'User', description: 'User combobox label' })}
              value={newUsername ? [newUsername] : []}
            >
              <DialogComboboxTrigger
                withInlineLabel={false}
                placeholder={intl.formatMessage({ defaultMessage: 'Select user', description: 'User combobox placeholder' })}
                css={{ minWidth: 180 }}
                onClear={() => setNewUsername('')}
              />
              <DialogComboboxContent>
                <DialogComboboxOptionList>
                  <DialogComboboxOptionListSearch>
                    {users.map((u) => (
                      <DialogComboboxOptionListSelectItem
                        key={u}
                        value={u}
                        checked={u === newUsername}
                        onChange={(v) => setNewUsername(v)}
                      >
                        {u}
                      </DialogComboboxOptionListSelectItem>
                    ))}
                  </DialogComboboxOptionListSearch>
                </DialogComboboxOptionList>
              </DialogComboboxContent>
            </DialogCombobox>
            <SimpleSelect
              id="project_perms_add_level"
              componentId="project_perms.add_level"
              value={newPermission}
              onChange={({ target }) => setNewPermission(target.value as PermissionLevel)}
            >
              {PERMISSION_LEVELS.map((lvl) => (
                <SimpleSelectOption key={lvl} value={lvl}>
                  {lvl}
                </SimpleSelectOption>
              ))}
            </SimpleSelect>
            <Button
              componentId="project_perms.add_button"
              type="primary"
              loading={grantPermission.isLoading}
              onClick={handleAddAccess}
            >
              <FormattedMessage defaultMessage="Grant" description="Grant access button" />
            </Button>
          </div>
          <Typography.Hint>
            <FormattedMessage
              defaultMessage="READ = view only · USE = log runs · EDIT = modify · MANAGE = full control"
              description="Permission level descriptions in project permissions modal"
            />
          </Typography.Hint>
        </div>

        {/* User access table */}
        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
          <Typography.Text bold>
            <FormattedMessage defaultMessage="Current access" description="Section heading for existing permissions" />
          </Typography.Text>
          {usersLoading ? (
            <div css={{ display: 'flex', justifyContent: 'center', padding: theme.spacing.lg }}>
              <Spinner size="small" />
            </div>
          ) : users.length === 0 ? (
            <Empty
              description={intl.formatMessage({
                defaultMessage: 'No users found.',
                description: 'Empty state in access table',
              })}
            />
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
                <TableHeader componentId="project_perms.user_header" css={{ flex: 2 }}>
                  <FormattedMessage defaultMessage="User" description="Access table user column header" />
                </TableHeader>
                <TableHeader componentId="project_perms.perm_header" css={{ flex: 2 }}>
                  <FormattedMessage defaultMessage="Permission" description="Access table permission column header" />
                </TableHeader>
                <TableHeader componentId="project_perms.actions_header" css={{ flex: 1 }}>
                  <FormattedMessage defaultMessage="Actions" description="Access table actions column header" />
                </TableHeader>
              </TableRow>
              {users.map((username) => (
                <UserAccessRow
                  key={username}
                  username={username}
                  experimentId={experimentId}
                  onChanged={() => {}}
                />
              ))}
            </Table>
          )}
        </div>
      </div>
    </Modal>
  );
};
