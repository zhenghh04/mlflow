/**
 * SSOCompletePage — handles the final step of the SSO flow.
 *
 * After the provider redirects back to /sso/callback/<id>, the server
 * validates the code and issues a session token, then redirects here as
 *   /#/sso-complete?t=<token>
 *
 * This page:
 *  1. Reads the token from the URL query parameter.
 *  2. Calls GET /sso/verify?t=<token> to get the username + preferred team.
 *  3. Sets mlflow-request-header-X-SSO-Token cookie via JavaScript so
 *     FetchUtils includes it as the X-SSO-Token header on every AJAX call.
 *  4. Sets the team cookie so the sidebar switches to the right context.
 *  5. Clears the token from the URL and navigates to the experiments page.
 */

import { useEffect, useState } from 'react';
import { Spinner, Typography, useDesignSystemTheme } from '@databricks/design-system';
import { MlflowLogo } from '../common/components/MlflowLogo';
import { useNavigate, useSearchParams } from '../common/utils/RoutingUtils';
import { useQueryClient } from '../common/utils/reactQueryHooks';
import { setActiveTeam } from './team-context';
import ExperimentTrackingRoutes from '../experiment-tracking/routes';

const SSO_HEADER_COOKIE = 'mlflow-request-header-X-SSO-Token';

const setSSOMCookie = (token: string): void => {
  const paths = ['/'];
  for (const path of paths) {
    document.cookie = `${SSO_HEADER_COOKIE}=${encodeURIComponent(token)}; path=${path}; SameSite=Lax; max-age=43200`;
  }
};

const SSOCompletePage = () => {
  const { theme } = useDesignSystemTheme();
  const navigate = useNavigate({ bypassWorkspacePrefix: true });
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get('t') ?? '';
    if (!token) {
      setError('No SSO token found in URL. Please try logging in again.');
      return;
    }

    fetch(`/sso/verify?t=${encodeURIComponent(token)}`, {
      credentials: 'same-origin',
    })
      .then((r) => {
        if (!r.ok) throw new Error(`SSO verification failed (${r.status})`);
        return r.json();
      })
      .then(({ preferred_team }: { username: string; token: string; preferred_team: string }) => {
        // Set the explicit SSO header cookie — FetchUtils picks this up and
        // adds X-SSO-Token to every subsequent AJAX request.
        setSSOMCookie(token);

        // Switch to the user's preferred team
        if (preferred_team) {
          setActiveTeam(preferred_team);
        }

        // Clear all cached queries so they re-fetch with the new identity
        queryClient.clear();

        // Navigate to the experiments home
        navigate(ExperimentTrackingRoutes.rootRoute);
      })
      .catch((err: Error) => {
        setError(err.message || 'SSO login failed. Please try again.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      css={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        gap: theme.spacing.lg,
        backgroundColor: theme.colors.backgroundSecondary,
      }}
    >
      <MlflowLogo css={{ height: 28, color: theme.colors.textPrimary }} />
      {error ? (
        <Typography.Text color="error">{error}</Typography.Text>
      ) : (
        <>
          <Spinner size="large" />
          <Typography.Text color="secondary">Completing sign-in…</Typography.Text>
        </>
      )}
    </div>
  );
};

export default SSOCompletePage;
