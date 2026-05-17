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
  for (const path of getAuthCookiePaths()) {
    document.cookie = `${AUTH_HEADER_COOKIE}=${encodeURIComponent(`Basic ${encoded}`)}; path=${path}`;
    document.cookie = `${MLFLOW_USER_COOKIE}=${encodedUsername}; path=${path}`;
  }
};

export const performLogout = (queryClient?: { clear: () => void }) => {
  clearAuthCookies();
  queryClient?.clear();

  // Redirect to our login page after clearing cookies
  const loginUrl = new URL('.', window.location.href).toString() + '#/login';

  // Always try the XHR trick to bust the browser's Basic Auth cache — it is a
  // no-op for SSO sessions but harmless. Redirect to /#/login in both cases.
  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const bogus = `mlflow-logged-out-${nonce}`;
  const usersCurrentUrl = new URL('ajax-api/2.0/mlflow/users/current', window.location.href).toString();

  const goLogin = () => window.location.assign(loginUrl);
  try {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', usersCurrentUrl, true, bogus, bogus);
    xhr.onloadend = goLogin;
    xhr.send();
  } catch {
    goLogin();
  }
};
