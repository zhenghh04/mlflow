// Cookie names for team/tenant routing.
// ``TEAM_HEADER_COOKIE`` is read by ``FetchUtils.getDefaultHeadersFromCookies``
// and forwarded as the ``X-MLflow-Tenant`` request header.
const TEAM_HEADER_COOKIE = 'mlflow-request-header-X-MLflow-Tenant';
const TEAM_SLUG_COOKIE = 'mlflow_active_team';

/** Return the active team slug that the server currently sees. Defaults to 'default'. */
export const getActiveTeamSlug = (): string => {
  const raw =
    document.cookie
      .split('; ')
      .find((r) => r.startsWith(`${TEAM_HEADER_COOKIE}=`))
      ?.substring(`${TEAM_HEADER_COOKIE}=`.length) ?? '';
  try {
    return decodeURIComponent(raw) || 'default';
  } catch {
    return raw || 'default';
  }
};

/** Write the active team slug to both the header-forwarding cookie and a
 *  human-readable slug cookie so other parts of the UI can read it cheaply. */
export const setActiveTeam = (slug: string): void => {
  const paths = ['/', window.location.pathname.replace(/\/$/, '') || '/'];
  for (const path of [...new Set(paths)]) {
    document.cookie = `${TEAM_HEADER_COOKIE}=${encodeURIComponent(slug)}; path=${path}`;
    document.cookie = `${TEAM_SLUG_COOKIE}=${encodeURIComponent(slug)}; path=${path}`;
  }
};
