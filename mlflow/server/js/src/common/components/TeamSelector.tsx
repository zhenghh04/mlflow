import { useState, useEffect } from 'react';
import { SimpleSelect, SimpleSelectOption, Spinner, Typography, useDesignSystemTheme } from '@databricks/design-system';
import { useQueryClient } from '@mlflow/mlflow/src/common/utils/reactQueryHooks';
import { getDefaultHeaders } from '../utils/FetchUtils';
import { getActiveTeamSlug, setActiveTeam } from '../../account/team-context';

interface TeamEntry {
  slug: string;
  name: string;
  role: string;
}

/**
 * Fetches the user's team list.
 *
 * Uses native fetch (no retry middleware) but reads the
 * ``mlflow-request-header-*`` cookies via ``getDefaultHeaders`` so the
 * ``Authorization`` header is set correctly for cookie-based Basic Auth
 * (the pattern used by our login form).
 */
const fetchUserTeams = async (): Promise<TeamEntry[]> => {
  const res = await fetch('ajax-api/3.0/mlflow/users/teams', {
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...getDefaultHeaders(document.cookie),
    },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data?.teams ?? [];
};

/**
 * Sidebar team switcher.
 *
 * - Hidden when the user belongs to only one (or zero) teams.
 * - Shows a small initial avatar when the sidebar is collapsed.
 * - Full select dropdown when expanded.
 */
export const TeamSelector = ({ collapsed }: { collapsed: boolean }) => {
  const { theme } = useDesignSystemTheme();
  const queryClient = useQueryClient();

  const [activeSlug, setActiveSlug] = useState(getActiveTeamSlug);
  const [teams, setTeams] = useState<TeamEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchUserTeams()
      .then((t) => { if (!cancelled) { setTeams(t); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return collapsed ? null : (
      <div css={{ paddingInline: theme.spacing.sm, paddingBlock: theme.spacing.xs }}>
        <Spinner size="small" />
      </div>
    );
  }

  if (teams.length <= 1) return null;

  const handleChange = ({ target }: { target: { value: string } }) => {
    const slug = target.value;
    setActiveTeam(slug);
    setActiveSlug(slug);
    // Clear cache so all active queries re-fetch under the new tenant.
    // Do NOT navigate away — stay on the current page.
    queryClient.clear();
  };

  const activeTeam = teams.find((t) => t.slug === activeSlug) ?? teams[0];

  return (
    <div
      css={{
        paddingInline: theme.spacing.xs,
        paddingBlock: theme.spacing.xs,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing.xs,
      }}
    >
      {!collapsed && (
        <Typography.Text size="sm" color="secondary" css={{ paddingLeft: 2 }}>
          Team
        </Typography.Text>
      )}
      {collapsed ? (
        <div
          title={activeTeam?.name ?? 'Team'}
          css={{
            width: 26, height: 26,
            borderRadius: '50%',
            backgroundColor: theme.colors.actionPrimaryBackgroundDefault,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700,
            color: theme.colors.white,
            cursor: 'default',
            userSelect: 'none',
          }}
        >
          {(activeTeam?.name ?? 'T')[0].toUpperCase()}
        </div>
      ) : (
        <SimpleSelect
          id="team-selector"
          componentId="mlflow.sidebar.team_selector"
          value={activeSlug}
          onChange={handleChange}
        >
          {teams.map((t) => (
            <SimpleSelectOption key={t.slug} value={t.slug}>
              {t.name}
              {t.role === 'admin' ? ' ★' : ''}
            </SimpleSelectOption>
          ))}
        </SimpleSelect>
      )}
    </div>
  );
};
