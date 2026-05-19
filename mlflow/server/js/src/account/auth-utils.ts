import { btoaUtf8 as _btoaUtf8 } from '../common/utils/StringUtils';
export { btoaUtf8 } from '../common/utils/StringUtils';
export const AUTH_HEADER_COOKIE = 'mlflow-request-header-Authorization';
export const MLFLOW_USER_COOKIE = 'mlflow_user';
// SSO session cookie — set by the server after a successful OAuth2 callback
export const SSO_TOKEN_COOKIE = 'mlflow_sso_token';
// Team context cookie — cleared on logout so the switcher resets
export const TEAM_HEADER_COOKIE = 'mlflow-request-header-X-MLflow-Tenant';
export const ACTIVE_TEAM_COOKIE = 'mlflow_active_team';

const AUTH_COOKIE_NAMES = [
  MLFLOW_USER_COOKIE,
  AUTH_HEADER_COOKIE,
  SSO_TOKEN_COOKIE,
  TEAM_HEADER_COOKIE,
  ACTIVE_TEAM_COOKIE,
];

/**
 * Cookie deletion does an exact path match, so cover root + the app's
 * base path (with and without trailing slash) - otherwise cookies set
 * under a static prefix like ``/mlflow/`` survive a ``path=/`` delete.
 */
export const getAuthCookiePaths = (): string[] => {
  const paths = new Set<string>(['/']);
  const basePath = new URL('.', window.location.href).pathname;
  if (basePath) {
    paths.add(basePath);
    const stripped = basePath.replace(/\/$/, '');
    if (stripped) paths.add(stripped);
  }
  return Array.from(paths);
};

export const clearAuthCookies = () => {
  const expiresAttr = 'expires=Thu, 01 Jan 1970 00:00:00 UTC';
  for (const name of AUTH_COOKIE_NAMES) {
    for (const path of getAuthCookiePaths()) {
      document.cookie = `${name}=; ${expiresAttr}; path=${path};`;
    }
  }
};

/**
 * Basic Auth has no server-side session - logging out means making the
 * browser forget its cached realm creds. ``xhr.open(url, async, user,
 * pass)`` is the only API that overwrites them; ``fetch()`` with an
 * ``Authorization`` header is treated as a one-off override and leaves
 * the cache intact.
 */
/**
 * Write Basic Auth credentials into the cookies that FetchUtils reads on
 * every request.  Use ``btoaUtf8`` (re-exported from auth-utils) so
 * non-ASCII usernames/passwords encode correctly.
 */
export const applyCredentials = (username: string, password: string) => {
  const encoded = _btoaUtf8(`${username}:${password}`);
  const encodedUsername = encodeURIComponent(username);
  const expiresAttr = 'expires=Thu, 01 Jan 1970 00:00:00 UTC';
  for (const path of getAuthCookiePaths()) {
    // Clear any active SSO session so Basic Auth takes precedence on the server.
    // Without this, the server always authenticates via the SSO token (checked
    // first in _authenticate_sso_token) and ignores the new Basic Auth cookie.
    document.cookie = `${SSO_TOKEN_COOKIE}=; ${expiresAttr}; path=${path};`;
    document.cookie = `mlflow-request-header-X-SSO-Token=; ${expiresAttr}; path=${path};`;
    document.cookie = `${AUTH_HEADER_COOKIE}=${encodeURIComponent(`Basic ${encoded}`)}; path=${path}`;
    document.cookie = `${MLFLOW_USER_COOKIE}=${encodedUsername}; path=${path}`;
  }
};

export const performLogout = (queryClient?: { clear: () => void }) => {
  // 1. Clear all client-side auth cookies immediately
  clearAuthCookies();
  queryClient?.clear();

  // 2. Navigate to the server-side logout endpoint.
  //    The server sets Set-Cookie: mlflow_sso_token=; Max-Age=0 (server-side
  //    clearing is more reliable than JS for Secure/HttpOnly cookies) and then
  //    redirects to /#/login.
  window.location.assign('/sso/logout');
};
