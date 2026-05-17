import { useState } from 'react';
import { SimpleSelect, SimpleSelectOption, useDesignSystemTheme } from '@databricks/design-system';
import { useQuery, useQueryClient } from '@mlflow/mlflow/src/common/utils/reactQueryHooks';
import { useNavigate } from '../utils/RoutingUtils';
import ExperimentTrackingRoutes from '../../experiment-tracking/routes';
import { getUserTeams } from '../../admin/api';
import { getActiveTeamSlug, setActiveTeam } from '../../account/team-context';

/**
 * Sidebar team switcher. Renders a SimpleSelect when the sidebar is expanded,
 * or a small avatar initial when collapsed. Hidden entirely when the user
 * belongs to only one (or zero) teams.
 */
export const TeamSelector = ({ collapsed }: { collapsed: boolean }) => {
  const { theme } = useDesignSystemTheme();
  const queryClient = useQueryClient();
  const navigate = useNavigate({ bypassWorkspacePrefix: true });
  const [activeSlug, setActiveSlug] = useState(getActiveTeamSlug);

  const { data } = useQuery({
    queryKey: ['user_teams'],
    queryFn: getUserTeams,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const teams = data?.teams ?? [];
  if (teams.length <= 1) return null;

  const handleChange = ({ target }: { target: { value: string } }) => {
    const slug = target.value;
    setActiveTeam(slug);
    setActiveSlug(slug);
    queryClient.clear();
    navigate(ExperimentTrackingRoutes.rootRoute);
  };

  const activeTeam = teams.find((t) => t.slug === activeSlug) ?? teams[0];

  return (
    <div css={{ paddingInline: theme.spacing.xs, paddingBlock: theme.spacing.xs }}>
      {collapsed ? (
        <div
          css={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            backgroundColor: theme.colors.actionDefaultBackgroundHover,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 'bold',
            cursor: 'default',
            color: theme.colors.textPrimary,
          }}
          title={activeTeam?.name ?? 'Team'}
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
              {t.role === 'admin' ? ' (admin)' : ''}
            </SimpleSelectOption>
          ))}
        </SimpleSelect>
      )}
    </div>
  );
};
