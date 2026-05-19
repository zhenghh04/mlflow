import { useEffect, useState } from 'react';
import { Alert, Button, Input, Typography, useDesignSystemTheme } from '@databricks/design-system';
import { FormattedMessage, useIntl } from 'react-intl';
import { useNavigate } from '../common/utils/RoutingUtils';
import { useQueryClient } from '../common/utils/reactQueryHooks';
import { applyCredentials, btoaUtf8 } from './auth-utils';
import { getAjaxUrl } from '../common/utils/FetchUtils';
import { MlflowLogo } from '../common/components/MlflowLogo';
import { setActiveTeam } from './team-context';
import ExperimentTrackingRoutes from '../experiment-tracking/routes';

// ── SSO provider icons (simple text badges — no external icon deps) ──────────
const SSO_PROVIDER_COLORS: Record<string, string> = {
  github: '#24292f',
  google: '#4285F4',
  globus: '#00A0D6',
  oidc: '#5A5A5A',
};

interface SSOProvider {
  id: string;
  name: string;
  type: string;
  icon: string;
}

const useSSOProviders = (): SSOProvider[] => {
  const [providers, setProviders] = useState<SSOProvider[]>([]);
  useEffect(() => {
    fetch('/sso/providers', { credentials: 'same-origin' })
      .then((r) => r.ok ? r.json() : { providers: [] })
      .then((d) => setProviders(d.providers ?? []))
      .catch(() => {});
  }, []);
  return providers;
};

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

        <SSOSection theme={theme} />
      </div>
    </div>
  );
};

/** SSO provider buttons — rendered below the basic-auth form when providers are configured. */
const SSOSection = ({ theme }: { theme: ReturnType<typeof useDesignSystemTheme>['theme'] }) => {
  const providers = useSSOProviders();
  if (providers.length === 0) return null;

  const handleSSO = (providerId: string) => {
    window.location.href = `/sso/login?provider=${encodeURIComponent(providerId)}`;
  };

  return (
    <div css={{ display: 'flex', flexDirection: 'column', gap: theme.spacing.sm }}>
      <div css={{ display: 'flex', alignItems: 'center', gap: theme.spacing.sm }}>
        <div css={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />
        <Typography.Text color="secondary" size="sm">
          <FormattedMessage defaultMessage="or continue with" description="Divider between basic auth and SSO providers on login page" />
        </Typography.Text>
        <div css={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />
      </div>
      {providers.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-label={`Sign in with ${p.name}`}
          title={`Sign in with ${p.name}`}
          onClick={() => handleSSO(p.id)}
          css={{
            width: '100%',
            padding: `${theme.spacing.sm}px ${theme.spacing.md}px`,
            borderRadius: theme.general.borderRadiusBase,
            border: `1px solid ${theme.colors.border}`,
            backgroundColor: SSO_PROVIDER_COLORS[p.type] ?? '#5A5A5A',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.sm,
            fontSize: theme.typography.fontSizeBase,
            fontWeight: 600,
            '&:hover': { opacity: 0.88 },
            '&:active': { opacity: 0.75 },
          }}
        >
          <FormattedMessage
            defaultMessage="Sign in with {name}"
            description="SSO provider login button label"
            values={{ name: p.name }}
          />
        </button>
      ))}
    </div>
  );
};

export default LoginPage;
