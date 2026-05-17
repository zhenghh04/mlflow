import { useState } from 'react';
import { Alert, Button, Input, Typography, useDesignSystemTheme } from '@databricks/design-system';
import { FormattedMessage, useIntl } from 'react-intl';
import { useNavigate } from '../common/utils/RoutingUtils';
import { useQueryClient } from '../common/utils/reactQueryHooks';
import { applyCredentials, btoaUtf8 } from './auth-utils';
import { getAjaxUrl } from '../common/utils/FetchUtils';
import { MlflowLogo } from '../common/components/MlflowLogo';
import { setActiveTeam } from './team-context';
import ExperimentTrackingRoutes from '../experiment-tracking/routes';

const LoginPage = () => {
  const { theme } = useDesignSystemTheme();
  const intl = useIntl();
  const navigate = useNavigate({ bypassWorkspacePrefix: true });
  const queryClient = useQueryClient();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async () => {
    setError(null);

    if (!username.trim()) {
      setError(
        intl.formatMessage({
          defaultMessage: 'Username is required',
          description: 'Validation error when the username field is empty on the login page',
        }),
      );
      return;
    }

    if (!password) {
      setError(
        intl.formatMessage({
          defaultMessage: 'Password is required',
          description: 'Validation error when the password field is empty on the login page',
        }),
      );
      return;
    }

    setIsLoading(true);
    try {
      const url = getAjaxUrl('ajax-api/2.0/mlflow/users/current');
      const response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Basic ${btoaUtf8(`${username}:${password}`)}` },
      });

      if (!response.ok) {
        setError(
          intl.formatMessage({
            defaultMessage: 'Invalid username or password',
            description: 'Error shown on the login page when credentials are rejected',
          }),
        );
        return;
      }

      applyCredentials(username, password);

      // After setting auth credentials, fetch the user's teams and
      // auto-activate the first non-default team so the team switcher
      // and "Manage" link appear immediately after login.
      try {
        const teamsRes = await fetch(getAjaxUrl('ajax-api/3.0/mlflow/users/teams'), {
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            Authorization: `Basic ${btoaUtf8(`${username}:${password}`)}`,
          },
        });
        if (teamsRes.ok) {
          const teamsData = await teamsRes.json();
          const teams: { slug: string; name: string; role: string }[] = teamsData?.teams ?? [];
          const preferred = teams.find((t) => t.slug !== 'default') ?? teams[0];
          if (preferred) {
            setActiveTeam(preferred.slug);
          }
        }
      } catch {
        // non-critical: team context defaults to 'default'
      }

      queryClient.clear();
      navigate(ExperimentTrackingRoutes.rootRoute);
    } catch {
      setError(
        intl.formatMessage({
          defaultMessage: 'Could not connect to the server. Please try again.',
          description: 'Error shown on the login page when the network request fails',
        }),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleLogin();
    }
  };

  return (
    <div
      css={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        backgroundColor: theme.colors.backgroundSecondary,
      }}
    >
      <div
        css={{
          width: 380,
          display: 'flex',
          flexDirection: 'column',
          gap: theme.spacing.lg,
          padding: theme.spacing.xl,
          backgroundColor: theme.colors.backgroundPrimary,
          border: `1px solid ${theme.colors.border}`,
          borderRadius: theme.general.borderRadiusBase,
          boxShadow: theme.shadows.md,
        }}
      >
        <div css={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: theme.spacing.sm }}>
          <MlflowLogo
            css={{
              display: 'block',
              height: 28,
              color: theme.colors.textPrimary,
            }}
          />
          <Typography.Title level={3} withoutMargins css={{ textAlign: 'center' }}>
            <FormattedMessage defaultMessage="Sign in" description="Login page heading" />
          </Typography.Title>
        </div>

        {error && (
          <Alert
            componentId="login.error"
            type="error"
            message={error}
            closable
            onClose={() => setError(null)}
          />
        )}

        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
          <Typography.Text bold>
            <FormattedMessage defaultMessage="Username" description="Login page username label" />
          </Typography.Text>
          <Input
            componentId="login.username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            placeholder={intl.formatMessage({
              defaultMessage: 'Enter username',
              description: 'Placeholder for the username input on the login page',
            })}
          />
        </div>

        <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.xs }}>
          <Typography.Text bold>
            <FormattedMessage defaultMessage="Password" description="Login page password label" />
          </Typography.Text>
          <Input
            componentId="login.password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={intl.formatMessage({
              defaultMessage: 'Enter password',
              description: 'Placeholder for the password input on the login page',
            })}
          />
        </div>

        <Button
          componentId="login.submit"
          type="primary"
          loading={isLoading}
          onClick={handleLogin}
          css={{ width: '100%' }}
        >
          <FormattedMessage defaultMessage="Sign in" description="Login page submit button" />
        </Button>
      </div>
    </div>
  );
};

export default LoginPage;
